/**
 * The connector's queue-observation merger (M98f).
 *
 * M98b permits one authenticated client session, so the connector — not the
 * client — keeps one internal cursor per queue source. Each authenticated
 * queue read first DRAINS every retained source's newly captured attempts, in
 * registration order, into a connector-owned bounded merge ring, and then
 * serves the requested page of THAT ring through one public numeric cursor.
 * Registry tokens and plugin names never reach the wire: a source is
 * identified only by its connector-assigned `q<N>` position.
 *
 * Two bounded rings, two losses, never folded together: an eviction from the
 * MERGE ring is the batch's `lost`, while a source ring that wrapped between
 * two drains — a busy queue outrunning the poller — is accumulated onto that
 * source's own status `lost`. A contiguous merge sequence therefore never
 * hides attempts that were already gone before the connector read them.
 *
 * @module
 */

import type {
  IQueueDiagnosticsSource,
  QueueAttemptObservation,
  QueueDepthObservation,
  QueueDiagnosticsBatch,
  QueueDiagnosticsSourceStatus,
} from '@setu-ts/common';

import {
  MAX_QUEUE_SOURCES,
  readQueueSourceBatch,
  type ValidatedSourceAttempt,
  type ValidatedSourceDepth,
} from '../protocol/queue-protocol.ts';

/**
 * The fixed merge-ring bound.
 *
 * @internal
 */
export const MAX_MERGED_ATTEMPTS = 1_024;

/** The per-source read size the drain requests. */
const DRAIN_READ_LIMIT = 128;

/**
 * The most reads one drain issues to one source: enough to empty a full
 * 1,024-attempt source ring once, so a drain is bounded work even against a
 * source that keeps producing.
 */
const MAX_DRAIN_READS = 1_024 / DRAIN_READ_LIMIT + 1;

/** The fixed frame budget the merged batch must fit, as compact UTF-8 JSON. */
const MAX_FRAME_BYTES = 256 * 1024;

/** Adds with saturation at `Number.MAX_SAFE_INTEGER`. */
function saturatingAdd(current: number, delta: number): number {
  return current > Number.MAX_SAFE_INTEGER - delta ? Number.MAX_SAFE_INTEGER : current + delta;
}

/** One merged attempt, with the age anchor the next read recomputes from. */
interface MergedAttempt {
  readonly sequence: number;
  readonly sourceIndex: number;
  readonly attempt: ValidatedSourceAttempt;
  readonly instanceAlias: string;
  readonly ageAtDrainMs: number;
  readonly drainedAtMs: number;
}

/** One source's connector-side state. */
interface SourceSlot {
  readonly source: IQueueDiagnosticsSource;
  readonly sourceId: string;
  cursor: number;
  lost: number;
  status: Omit<QueueDiagnosticsSourceStatus, 'sourceId' | 'lost'>;
  depths: readonly ValidatedSourceDepth[];
  depthsReadAtMs: number;
}

/**
 * A monotonic clock.
 *
 * @internal
 */
export interface QueueMergerClock {
  /** Returns monotonic milliseconds. */
  hrtime(): number;
}

/**
 * The merge seam the connector handler calls, injected so the handler can be
 * tested against a merger answering an invalid batch.
 *
 * @internal
 */
export interface IQueueMerger {
  /**
   * Drains every source, then serves one page of the merge ring.
   *
   * @param instanceId - The session's bound instance UUID
   * @param after - Exclusive merge cursor
   * @param limit - Maximum events, 1–128
   * @returns The merged batch, or `null` when `after` is beyond the merge sequence
   */
  read(instanceId: string, after: number, limit: number): QueueDiagnosticsBatch | null;
}

/**
 * The merger over the retained sources.
 *
 * @internal
 */
export class QueueObservationMerger implements IQueueMerger {
  readonly #slots: readonly SourceSlot[];
  readonly #truncatedSources: number;
  readonly #clock: QueueMergerClock;
  readonly #ring: MergedAttempt[] = [];
  #sequence = 0;
  #closed = false;

  /**
   * Creates the merger over the registered sources. Only the first 16, in
   * registration order, are ever read; the rest are counted.
   *
   * @param sources - Every registered queue source, in registration order
   * @param clock - The monotonic clock
   */
  constructor(sources: readonly IQueueDiagnosticsSource[], clock: QueueMergerClock) {
    this.#clock = clock;
    this.#truncatedSources = Math.max(0, sources.length - MAX_QUEUE_SOURCES);
    this.#slots = sources.slice(0, MAX_QUEUE_SOURCES).map((source, index) => ({
      source,
      sourceId: `q${index + 1}`,
      cursor: 0,
      lost: 0,
      status: {
        state: 'no-data',
        depthCoverage: 'pending',
        failure: 'none',
        droppedAttempts: 0,
        evictedJobAliases: 0,
      },
      depths: [],
      depthsReadAtMs: 0,
    }));
  }

  /**
   * Discards everything retained — the merge ring, each source's latest
   * depths — and stops draining. The plugin calls it when the session is
   * revoked, so nothing captured for it outlives the revocation. Idempotent.
   */
  close(): void {
    this.#closed = true;
    this.#ring.length = 0;
    for (const slot of this.#slots) {
      slot.depths = [];
    }
  }

  /** {@inheritDoc IQueueMerger.read} */
  read(instanceId: string, after: number, limit: number): QueueDiagnosticsBatch | null {
    const now = this.#clock.hrtime();
    if (!this.#closed) {
      this.#slots.forEach((slot, index) => this.#drain(slot, index, now));
    }
    if (after > this.#sequence) {
      return null;
    }
    const first = this.#ring.length > 0 ? this.#ring[0].sequence : this.#sequence + 1;
    const start = Math.max(after + 1, first);
    const events: QueueAttemptObservation[] = [];
    for (const merged of this.#ring) {
      if (merged.sequence < start) {
        continue;
      }
      if (events.length === limit) {
        break;
      }
      events.push({
        sequence: merged.sequence,
        sourceId: this.#slots[merged.sourceIndex].sourceId,
        instanceAlias: merged.instanceAlias,
        queueAlias: merged.attempt.queueAlias,
        jobAlias: merged.attempt.jobAlias,
        attempt: merged.attempt.attempt,
        durationMs: merged.attempt.durationMs,
        outcome: merged.attempt.outcome,
        settlement: merged.attempt.settlement,
        ageMs: merged.ageAtDrainMs + (now - merged.drainedAtMs),
      });
    }
    const depths: QueueDepthObservation[] = [];
    for (const slot of this.#slots) {
      if (slot.status.instanceAlias === undefined) {
        continue;
      }
      for (const depth of slot.depths) {
        depths.push({
          sourceId: slot.sourceId,
          instanceAlias: slot.status.instanceAlias,
          queueAlias: depth.queueAlias,
          ready: depth.ready,
          processing: depth.processing,
          dead: depth.dead,
          scope: depth.scope,
          coverage: depth.coverage,
          ageMs: depth.ageMs + (now - slot.depthsReadAtMs),
        });
      }
    }
    return fitFrameBudget({
      version: 1,
      instanceId,
      state: this.#slots.length === 0 ? 'unsupported' : 'ready',
      sources: this.#slots.map((slot) => ({
        sourceId: slot.sourceId,
        ...slot.status,
        lost: slot.lost,
      })),
      events,
      depths,
      next: events.length > 0 ? events[events.length - 1].sequence : after,
      lost: events.length > 0 ? start - after - 1 : 0,
      truncatedSources: this.#truncatedSources,
      truncatedDepths: 0,
    });
  }

  /**
   * Drains one source into the merge ring. Bounded: at most enough reads to
   * empty a full source ring once. A source that throws or answers a batch the
   * exact validator refuses is reported `collection-failed` with the fixed
   * `source-read-failed` category, its cursor unchanged — and nothing it
   * returned is merged.
   */
  #drain(slot: SourceSlot, index: number, now: number): void {
    for (let read = 0; read < MAX_DRAIN_READS; read++) {
      let validated;
      try {
        validated = readQueueSourceBatch(
          slot.source.read(slot.cursor, DRAIN_READ_LIMIT),
          slot.cursor,
        );
      } catch {
        validated = null;
      }
      if (validated === null) {
        slot.status = {
          state: 'collection-failed',
          depthCoverage: slot.status.depthCoverage,
          failure: 'source-read-failed',
          droppedAttempts: slot.status.droppedAttempts,
          evictedJobAliases: slot.status.evictedJobAliases,
        };
        slot.depths = [];
        return;
      }
      slot.status = {
        state: validated.state,
        ...(validated.instanceAlias === null ? {} : { instanceAlias: validated.instanceAlias }),
        depthCoverage: validated.depthCoverage,
        failure: validated.failure,
        droppedAttempts: validated.droppedAttempts,
        evictedJobAliases: validated.evictedJobAliases,
      };
      slot.depths = validated.depths;
      slot.depthsReadAtMs = now;
      slot.lost = saturatingAdd(slot.lost, validated.lost);
      slot.cursor = validated.next;
      for (const attempt of validated.attempts) {
        this.#sequence += 1;
        this.#ring.push({
          sequence: this.#sequence,
          sourceIndex: index,
          attempt,
          instanceAlias: validated.instanceAlias as string,
          ageAtDrainMs: attempt.ageMs,
          drainedAtMs: now,
        });
        if (this.#ring.length > MAX_MERGED_ATTEMPTS) {
          this.#ring.shift();
        }
      }
      if (validated.closed || validated.attempts.length < DRAIN_READ_LIMIT) {
        return;
      }
    }
  }
}

/**
 * Keeps the merged batch within the fixed 256 KiB frame budget, measured as
 * the exact UTF-8 length of its compact JSON — the number the wire consumer
 * measures. Only depths are ever trimmed, from the tail, and counted in
 * `truncatedDepths`: they are a latest-only view repeated on every read,
 * while events are pageable, and trimming events could starve the cursor
 * behind a depth set that alone nearly fills the frame.
 *
 * Trimming depths alone always suffices. Every other member is bounded well
 * below the budget: at most 16 statuses and 128 events, each built from
 * fixed-vocabulary fields, counters, a `q<N>` id, a `j<N>` alias and aliases
 * of at most 64 UTF-8 bytes (control characters are refused, so JSON escaping
 * at most doubles an alias). That worst case is under 70 KiB, a bound the
 * merger's tests assert by construction.
 *
 * @param batch - The complete merged batch
 * @returns The bounded batch
 * @internal
 */
export function fitFrameBudget(batch: QueueDiagnosticsBatch): QueueDiagnosticsBatch {
  const encoder = new TextEncoder();
  const withDepths = (count: number): QueueDiagnosticsBatch =>
    count === batch.depths.length ? batch : {
      ...batch,
      depths: batch.depths.slice(0, count),
      truncatedDepths: batch.truncatedDepths + batch.depths.length - count,
    };
  const fits = (count: number): boolean =>
    encoder.encode(JSON.stringify(withDepths(count))).length <= MAX_FRAME_BYTES;
  if (fits(batch.depths.length)) {
    return batch;
  }
  // Dropping a suffix only shrinks the encoding, so the largest fitting
  // prefix is found by bisection over [0, depths.length - 1].
  let low = 0;
  let high = batch.depths.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (fits(mid)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return withDepths(low);
}
