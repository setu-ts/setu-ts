/**
 * One sweep of one store's pending set (M107 §3.6–§3.9).
 *
 * The sweep pages `scanPending(cursor, …)` and examines rows ONE AT A TIME in
 * `position` order while three budgets last: rows examined (`scanLimit`),
 * rows published or poisoned (`publishLimit`), and one deadline over the
 * whole sweep (`sweepDeadlineMs`, on the monotonic clock). A row starts only
 * while the deadline leaves room for its publish AND its status write.
 *
 * Every status write is a conditional transition (the store writes only from
 * the expected status). A rejected or expired store call ends the sweep with
 * the row's key blocked, so no later row of that key is published before the
 * next lap re-reads the still-`pending` row. Once the outbox is closing, a
 * publish failure writes nothing — a failure the application's own shutdown
 * caused is never counted against `maxAttempts`.
 *
 * @module
 */
import type {
  IMessageBroker,
  IOutboxStore,
  IRuntimeServices,
  ITelemetryService,
  OutboxRecord,
  OutboxTransition,
  SpanOptions,
} from '@setu-ts/common';
import { parseTraceparentToContext, resolveProbeTiming, withDeadline } from '@setu-ts/common';

import { describeError } from '../brokers/describe-error.ts';
import { OutboxLap } from './lap.ts';
import type { ResolvedOutboxOptions } from './options.ts';
import { blockKey } from './position.ts';
import type { DecodedOutboxRow } from './record-codec.ts';
import { decodeOutboxRecord } from './record-codec.ts';

/** The most characters of `lastError` a row stores. */
const MAX_LAST_ERROR = 1024;

/** The `lastError` an undecodable row is marked with. */
export const INVALID_ROW_ERROR = 'invalid-row';

/**
 * Why one store's part of a sweep ended.
 *
 * @internal
 */
export type StoreSweepEnd =
  | 'lap-complete'
  | 'scan-limit'
  | 'publish-limit'
  | 'deadline'
  | 'store-failure'
  | 'closing';

/**
 * What a sweep reports as it goes — the hooks the outbox service records for
 * health and forwards to the optional metrics collector. Implementations must
 * not throw.
 *
 * @internal
 */
export interface OutboxRelayObserver {
  /** A row was published. */
  published(topic: string): void;
  /** A publish failed and the failure was recorded (or the store refused it). */
  publishFailed(topic: string): void;
  /** A row became `failed`; `topic` is absent for an undecodable row. */
  poisoned(topic: string | undefined): void;
  /**
   * A row this sweep published was already `sent`: by another instance's
   * scheduled sweep while this one was scheduled (`scheduled`), with a
   * dispatch sweep involved (`dispatch`), or by this instance (`stale`).
   */
  overlap(kind: 'scheduled' | 'dispatch' | 'stale'): void;
}

/**
 * The counters and clock one sweep shares across every store it visits.
 *
 * @internal
 */
export class SweepBudget {
  readonly #runtime: IRuntimeServices;
  readonly #startedAt: number;
  readonly #deadlineMs: number;
  /** Rows examined, skips included. */
  scanned = 0;
  /** Rows published or poisoned — what `publishLimit` bounds. */
  attempted = 0;
  /** Rows published. */
  published = 0;
  /** Publish failures recorded. */
  failures = 0;
  /** Rows made `failed`. */
  poisoned = 0;

  /**
   * @param runtime - Supplies the monotonic clock
   * @param deadlineMs - `sweepDeadlineMs`
   */
  constructor(runtime: IRuntimeServices, deadlineMs: number) {
    this.#runtime = runtime;
    this.#deadlineMs = deadlineMs;
    this.#startedAt = runtime.hrtime();
  }

  /** Milliseconds left before the sweep deadline. */
  remaining(): number {
    return this.#deadlineMs - (this.#runtime.hrtime() - this.#startedAt);
  }
}

/**
 * Everything one sweep needs.
 *
 * @internal
 */
export interface RelayContext {
  readonly runtime: IRuntimeServices;
  readonly broker: IMessageBroker;
  readonly telemetry: ITelemetryService | undefined;
  readonly options: ResolvedOutboxOptions;
  /** This outbox instance's id. */
  readonly instanceId: string;
  /** What requested this sweep. */
  readonly origin: 'scheduled' | 'dispatch';
  readonly isClosing: () => boolean;
  readonly observer: OutboxRelayObserver;
  readonly budget: SweepBudget;
}

/**
 * The lap a store's sweep resumes. The service keeps one per store; a sweep
 * clears it when the lap ends.
 *
 * @internal
 */
export interface LapHolder {
  lap: OutboxLap | undefined;
}

/** An expired relay call: a failure, after which the sweep ends. */
class RelayCallTimeoutError extends Error {
  constructor(what: string) {
    super(`outbox: ${what} did not settle within its bound`);
    this.name = 'RelayCallTimeoutError';
  }
}

/**
 * Runs one relay call under `min(perCall, remaining)`, so no call outlives the
 * sweep deadline.
 */
function bounded<T>(
  ctx: RelayContext,
  perCallMs: number,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  const remaining = Math.ceil(ctx.budget.remaining());
  if (remaining <= 0) return Promise.reject(new RelayCallTimeoutError(what));
  return withDeadline(() => run(), {
    timeoutMs: Math.min(perCallMs, remaining),
    onTimeout: () => new RelayCallTimeoutError(what),
    timing: resolveProbeTiming(ctx.runtime),
  });
}

/** The budget that stops the sweep before its next row or page, if any. */
function stopReason(ctx: RelayContext): StoreSweepEnd | undefined {
  const { options, budget } = ctx;
  if (ctx.isClosing()) return 'closing';
  if (budget.remaining() < options.publishTimeoutMs + options.storeTimeoutMs) return 'deadline';
  if (budget.scanned >= options.scanLimit) return 'scan-limit';
  if (budget.attempted >= options.publishLimit) return 'publish-limit';
  return undefined;
}

/** A stored attempt count, or `0` when the row carries an unusable one. */
function attemptsOf(record: OutboxRecord): number {
  return Number.isSafeInteger(record.attempts) && record.attempts >= 0 ? record.attempts : 0;
}

/** `describeError`, cut to the stored length on a code-point boundary. */
function lastErrorOf(error: unknown): string {
  return Array.from(describeError(error)).slice(0, MAX_LAST_ERROR).join('');
}

/**
 * The span options for a row: a stored `traceparent` that parses to BOTH ids
 * re-parents the relay span; anything else — absent, malformed, edited —
 * starts a ROOT span, never one under whatever span happens to be active.
 */
function spanOptionsFor(record: OutboxRecord): SpanOptions {
  const stored = typeof record.traceparent === 'string' ? record.traceparent : null;
  const parent = parseTraceparentToContext(stored);
  return parent.traceId !== undefined && parent.spanId !== undefined
    ? { kind: 'internal', parentContext: parent }
    : { kind: 'internal', root: true };
}

/** Publishes one decoded row, inside a relay span when telemetry is present. */
function publish(ctx: RelayContext, record: OutboxRecord, row: DecodedOutboxRow): Promise<void> {
  const send = () => ctx.broker.publish(row.topic, row.envelope, row.options);
  if (ctx.telemetry === undefined) return send();
  return ctx.telemetry.withSpan(`outbox relay ${row.topic}`, send, spanOptionsFor(record));
}

/** Classifies a `markSent` that found the row already sent. */
function overlapKind(ctx: RelayContext, sentBy: string): 'scheduled' | 'dispatch' | 'stale' {
  const slash = sentBy.lastIndexOf('/');
  if (sentBy.slice(0, slash) === ctx.instanceId) return 'stale';
  return ctx.origin === 'scheduled' && sentBy.slice(slash + 1) === 'scheduled'
    ? 'scheduled'
    : 'dispatch';
}

/** Applies what a `markSent` answered after a successful publish. */
function onMarkSent(
  ctx: RelayContext,
  lap: OutboxLap,
  key: string | undefined,
  transition: OutboxTransition,
): void {
  if (transition.outcome !== 'not-pending') return;
  if (transition.status === 'sent' && transition.sentBy !== undefined) {
    ctx.observer.overlap(overlapKind(ctx, transition.sentBy));
  } else if (transition.status === 'failed' && key !== undefined) {
    // Another relay failed it meanwhile: it now blocks its key.
    lap.block(key);
  }
}

/**
 * Examines one row; answers why the sweep must end, or `undefined` to go on.
 */
async function examine(
  ctx: RelayContext,
  store: IOutboxStore,
  lap: OutboxLap,
  record: OutboxRecord,
): Promise<StoreSweepEnd | undefined> {
  const { options, budget, runtime } = ctx;
  const key = record.orderingKey !== undefined
    ? blockKey(record.tenantId, record.orderingKey)
    : undefined;
  if (key !== undefined) {
    if (lap.isBlocked(key)) return undefined;
    if (lap.capReached) {
      // A later row of this key may follow inside the lap: it must stay blocked.
      lap.block(key);
      return undefined;
    }
  }
  const now = runtime.now();
  if (record.availableAt > now) {
    // In backoff. Blocking the key keeps a later row from overtaking it.
    if (key !== undefined) lap.block(key);
    return undefined;
  }

  budget.attempted += 1;
  const decoded = decodeOutboxRecord(record, options.maxEnvelopeBytes);
  if (!decoded.ok) {
    if (key !== undefined) lap.block(key);
    let transition: OutboxTransition;
    try {
      transition = await bounded(
        ctx,
        options.storeTimeoutMs,
        'markFailure',
        () =>
          store.markFailure(record.id, {
            attempts: attemptsOf(record),
            lastError: INVALID_ROW_ERROR,
            availableAt: now,
            status: 'failed',
          }),
      );
    } catch {
      return 'store-failure';
    }
    if (transition.outcome === 'applied') {
      budget.poisoned += 1;
      ctx.observer.poisoned(undefined);
    }
    return undefined;
  }

  const { topic } = decoded.row;
  let failure: { readonly error: unknown } | undefined;
  try {
    await bounded(
      ctx,
      options.publishTimeoutMs,
      'publish',
      () => publish(ctx, record, decoded.row),
    );
  } catch (error) {
    failure = { error };
  }

  if (failure === undefined) {
    budget.published += 1;
    ctx.observer.published(topic);
    let transition: OutboxTransition;
    try {
      transition = await bounded(
        ctx,
        options.storeTimeoutMs,
        'markSent',
        () =>
          store.markSent(record.id, {
            settledAt: runtime.now(),
            sentBy: `${ctx.instanceId}/${ctx.origin}`,
            deleteNow: options.retainSentMs === 0,
          }),
      );
    } catch {
      // Published but not marked: block the key so no later row of it is
      // published before the next lap re-reads this still-pending row.
      if (key !== undefined) lap.block(key);
      return 'store-failure';
    }
    onMarkSent(ctx, lap, key, transition);
    return undefined;
  }

  if (key !== undefined) lap.block(key);
  // A failure while the application stops writes nothing: it is not the row's.
  if (ctx.isClosing()) return 'closing';
  budget.failures += 1;
  ctx.observer.publishFailed(topic);
  const attempts = attemptsOf(record) + 1;
  const status = attempts >= options.maxAttempts ? 'failed' : 'pending';
  const backoff = Math.min(options.baseBackoffMs * 2 ** (attempts - 1), options.maxBackoffMs);
  let transition: OutboxTransition;
  try {
    transition = await bounded(
      ctx,
      options.storeTimeoutMs,
      'markFailure',
      () =>
        store.markFailure(record.id, {
          attempts,
          lastError: lastErrorOf(failure.error),
          availableAt: now + backoff,
          status,
        }),
    );
  } catch {
    return 'store-failure';
  }
  if (transition.outcome === 'applied' && status === 'failed') {
    budget.poisoned += 1;
    ctx.observer.poisoned(topic);
  }
  return failure.error instanceof RelayCallTimeoutError ? 'deadline' : undefined;
}

/**
 * Sweeps one store: starts a lap when none is in progress (the ONLY place the
 * failed keys are read), then pages and examines rows until a budget runs out,
 * a store call fails, the outbox closes, or a short page ends the lap.
 *
 * @internal
 * @param ctx - The sweep's shared context and budget
 * @param store - The store to sweep
 * @param holder - The store's lap, resumed when one is in progress
 * @returns Why this store's part of the sweep ended
 */
export async function sweepStore(
  ctx: RelayContext,
  store: IOutboxStore,
  holder: LapHolder,
): Promise<StoreSweepEnd> {
  const { options, budget } = ctx;
  let lap = holder.lap;
  if (lap === undefined) {
    const stop = stopReason(ctx);
    if (stop !== undefined) return stop;
    let failed;
    try {
      failed = await bounded(
        ctx,
        options.storeTimeoutMs,
        'failedKeys',
        () => store.failedKeys(options.maxFailedScan),
      );
    } catch {
      return 'store-failure';
    }
    lap = new OutboxLap(failed, options.maxFailedScan);
    holder.lap = lap;
  }
  for (;;) {
    const stop = stopReason(ctx);
    if (stop !== undefined) return stop;
    const limit = Math.min(options.pageSize, options.scanLimit - budget.scanned);
    let page: readonly OutboxRecord[];
    const after = lap.cursor;
    try {
      page = await bounded(
        ctx,
        options.storeTimeoutMs,
        'scanPending',
        () => store.scanPending(after, limit),
      );
    } catch {
      return 'store-failure';
    }
    for (const record of page) {
      const rowStop = stopReason(ctx);
      if (rowStop !== undefined) return rowStop;
      budget.scanned += 1;
      lap.advance(record.position);
      const end = await examine(ctx, store, lap, record);
      if (end !== undefined) return end;
    }
    if (page.length < limit) {
      // Every pending row has been examined: the next sweep starts a new lap.
      holder.lap = undefined;
      return 'lap-complete';
    }
  }
}
