/**
 * Queue observation protocol (M98f): the exact validation of a queue source's
 * batch before the connector merges it, the field-by-field projection of the
 * merged batch, and the ONE validator both sides of the wire run over it.
 *
 * A queue source is a multi-provider contribution any installed plugin can
 * register, so its batch is untrusted input to the connector: every field is
 * read once, checked against its fixed vocabulary or bound, and copied — never
 * spread — so an unexpected field, a throwing getter, an oversized alias or a
 * control character cannot reach the signed frame.
 *
 * @module
 */

import type {
  QueueAttemptObservation,
  QueueDepthCoverage,
  QueueDepthCycleCoverage,
  QueueDepthObservation,
  QueueDepthScope,
  QueueDiagnosticsBatch,
  QueueDiagnosticsSourceStatus,
  QueueProcessorOutcome,
  QueueSettlementState,
  QueueSourceFailure,
  QueueSourceState,
} from '@setu-ts/common';

import { hasExactKeys, isDisplayAlias, isRecord } from './protocol.ts';

/** The per-read attempt bound a source honours, and so a source batch's ceiling. */
const MAX_SOURCE_ATTEMPTS = 128;

/** The approved-queue bound per source, and so a source batch's depth ceiling. */
const MAX_SOURCE_DEPTHS = 64;

/**
 * The fixed source bound: at most this many queue sources are read.
 *
 * @internal
 */
export const MAX_QUEUE_SOURCES = 16;

/** The connector's merge-read bound — the same fixed 128 as the events read. */
const MAX_MERGED_EVENTS = 128;

const SOURCE_STATES: ReadonlySet<string> = new Set<QueueSourceState>([
  'disabled',
  'no-data',
  'ready',
]);
const STATUS_STATES: ReadonlySet<string> = new Set<string>([
  'disabled',
  'no-data',
  'ready',
  'collection-failed',
]);
const DEPTH_COVERAGES: ReadonlySet<string> = new Set<QueueDepthCoverage>([
  'disabled',
  'unavailable',
  'pending',
  'complete',
  'partial',
]);
const SOURCE_FAILURES: ReadonlySet<string> = new Set<QueueSourceFailure>([
  'none',
  'depth-read-failed',
  'depth-read-timed-out',
]);
const STATUS_FAILURES: ReadonlySet<string> = new Set<string>([
  'none',
  'depth-read-failed',
  'depth-read-timed-out',
  'source-read-failed',
]);
const OUTCOMES: ReadonlySet<string> = new Set<QueueProcessorOutcome>([
  'completed',
  'retryable-error',
  'terminal-error',
]);
const SETTLEMENTS: ReadonlySet<string> = new Set<QueueSettlementState>([
  'acknowledged',
  'requeued',
  'dead-lettered',
  'failed',
  'unknown',
]);
const SCOPES: ReadonlySet<string> = new Set<QueueDepthScope>(['process-local', 'shared-backend']);
const CYCLE_COVERAGES: ReadonlySet<string> = new Set<QueueDepthCycleCoverage>([
  'complete',
  'partial',
]);

const JOB_ALIAS = /^j[1-9][0-9]{0,15}$/;
const SOURCE_ID = /^q(?:[1-9]|1[0-6])$/;

/** A non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A finite, non-negative millisecond measurement. */
function isMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Membership in a fixed vocabulary. */
function isOneOf(value: unknown, vocabulary: ReadonlySet<string>): value is string {
  return typeof value === 'string' && vocabulary.has(value);
}

/**
 * One validated source attempt, copied field by field.
 *
 * @internal
 */
export interface ValidatedSourceAttempt {
  readonly sequence: number;
  readonly queueAlias: string;
  readonly jobAlias: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly outcome: QueueProcessorOutcome;
  readonly settlement: QueueSettlementState;
  readonly ageMs: number;
}

/**
 * One validated source depth, copied field by field.
 *
 * @internal
 */
export interface ValidatedSourceDepth {
  readonly queueAlias: string;
  readonly ready: number;
  readonly processing: number;
  readonly dead: number;
  readonly scope: QueueDepthScope;
  readonly coverage: QueueDepthCycleCoverage;
  readonly ageMs: number;
}

/**
 * One validated source batch, copied field by field.
 *
 * @internal
 */
export interface ValidatedSourceBatch {
  readonly state: QueueSourceState;
  readonly instanceAlias: string | null;
  readonly depthCoverage: QueueDepthCoverage;
  readonly failure: QueueSourceFailure;
  readonly attempts: readonly ValidatedSourceAttempt[];
  readonly depths: readonly ValidatedSourceDepth[];
  readonly next: number;
  readonly lost: number;
  readonly closed: boolean;
  readonly droppedAttempts: number;
  readonly evictedJobAliases: number;
}

const SOURCE_BATCH_KEYS: readonly string[] = [
  'version',
  'state',
  'depthCoverage',
  'failure',
  'attempts',
  'depths',
  'next',
  'lost',
  'closed',
  'droppedAttempts',
  'evictedJobAliases',
];
const SOURCE_ATTEMPT_KEYS: readonly string[] = [
  'sequence',
  'queueAlias',
  'jobAlias',
  'attempt',
  'durationMs',
  'outcome',
  'settlement',
  'ageMs',
];
const SOURCE_DEPTH_KEYS: readonly string[] = [
  'queueAlias',
  'ready',
  'processing',
  'dead',
  'scope',
  'coverage',
  'ageMs',
];

/** Validates and copies one source attempt. */
function readSourceAttempt(value: unknown): ValidatedSourceAttempt | null {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_ATTEMPT_KEYS)) {
    return null;
  }
  const { sequence, queueAlias, jobAlias, attempt, durationMs, outcome, settlement, ageMs } = value;
  if (
    !isCount(sequence) || sequence < 1 || !isDisplayAlias(queueAlias) ||
    typeof jobAlias !== 'string' || !JOB_ALIAS.test(jobAlias) || !isCount(attempt) ||
    attempt < 1 || !isMs(durationMs) || !isOneOf(outcome, OUTCOMES) ||
    !isOneOf(settlement, SETTLEMENTS) || !isMs(ageMs)
  ) {
    return null;
  }
  return {
    sequence,
    queueAlias,
    jobAlias,
    attempt,
    durationMs,
    outcome: outcome as QueueProcessorOutcome,
    settlement: settlement as QueueSettlementState,
    ageMs,
  };
}

/** Validates and copies one source depth. */
function readSourceDepth(value: unknown): ValidatedSourceDepth | null {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_DEPTH_KEYS)) {
    return null;
  }
  const { queueAlias, ready, processing, dead, scope, coverage, ageMs } = value;
  if (
    !isDisplayAlias(queueAlias) || !isCount(ready) || !isCount(processing) || !isCount(dead) ||
    !isOneOf(scope, SCOPES) || !isOneOf(coverage, CYCLE_COVERAGES) || !isMs(ageMs)
  ) {
    return null;
  }
  return {
    queueAlias,
    ready,
    processing,
    dead,
    scope: scope as QueueDepthScope,
    coverage: coverage as QueueDepthCycleCoverage,
    ageMs,
  };
}

/**
 * Validates an untrusted queue source batch against the exact M98f DTO and
 * the M98a cursor contract for the cursor the connector requested, and
 * returns a field-by-field copy.
 *
 * Refused: any unknown, missing or extra key; a value outside its fixed
 * vocabulary or bound; an alias outside the display shape; `instanceAlias`
 * present exactly when the state is not `disabled` violated; a `disabled`
 * batch carrying any attempt or depth; more attempts or depths than the
 * source bounds allow; sequences not strictly increasing
 * past the cursor; and a `next`/`lost` pair disagreeing with the returned
 * attempts. Any throw while reading — a hostile getter — is a refusal too.
 *
 * @param value - The batch the source returned
 * @param cursor - The exclusive cursor the connector requested
 * @returns The validated copy, or `null` for any violation
 * @internal
 */
export function readQueueSourceBatch(
  value: unknown,
  cursor: number,
): ValidatedSourceBatch | null {
  try {
    if (!isRecord(value)) {
      return null;
    }
    const hasAlias = Object.hasOwn(value, 'instanceAlias');
    const keys = hasAlias ? [...SOURCE_BATCH_KEYS, 'instanceAlias'] : SOURCE_BATCH_KEYS;
    if (!hasExactKeys(value, keys) || value.version !== 1) {
      return null;
    }
    const state = value.state;
    if (!isOneOf(state, SOURCE_STATES) || hasAlias !== (state !== 'disabled')) {
      return null;
    }
    // Read once, then validate and store that same value: a hostile accessor
    // could otherwise answer differently on a second read. The check keys on key
    // presence, never on the value — `null` is this function's own "no alias"
    // sentinel, so a present `null` must be refused, not read as absent.
    const instanceAlias = hasAlias ? value.instanceAlias : null;
    if (hasAlias && !isDisplayAlias(instanceAlias)) {
      return null;
    }
    const {
      depthCoverage,
      failure,
      attempts: rawAttempts,
      depths: rawDepths,
      next,
      lost,
      closed,
      droppedAttempts,
      evictedJobAliases,
    } = value;
    if (
      !isOneOf(depthCoverage, DEPTH_COVERAGES) || !isOneOf(failure, SOURCE_FAILURES) ||
      !Array.isArray(rawAttempts) || rawAttempts.length > MAX_SOURCE_ATTEMPTS ||
      !Array.isArray(rawDepths) || rawDepths.length > MAX_SOURCE_DEPTHS ||
      !isCount(next) || !isCount(lost) || typeof closed !== 'boolean' ||
      !isCount(droppedAttempts) || !isCount(evictedJobAliases)
    ) {
      return null;
    }
    // A disabled source observes nothing. It carries no instance alias, so an
    // attempt it returned would enter the merge ring alias-less and fail the
    // exact projection validator on every later read of every source.
    if (state === 'disabled' && (rawAttempts.length > 0 || rawDepths.length > 0)) {
      return null;
    }
    const attempts: ValidatedSourceAttempt[] = [];
    let previous = cursor;
    for (const raw of rawAttempts) {
      const attempt = readSourceAttempt(raw);
      if (attempt === null || attempt.sequence <= previous) {
        return null;
      }
      previous = attempt.sequence;
      attempts.push(attempt);
    }
    const expectedNext = attempts.length > 0 ? attempts[attempts.length - 1].sequence : cursor;
    const expectedLost = attempts.length > 0 ? attempts[0].sequence - cursor - 1 : 0;
    if (next !== expectedNext || lost !== expectedLost) {
      return null;
    }
    const depths: ValidatedSourceDepth[] = [];
    for (const raw of rawDepths) {
      const depth = readSourceDepth(raw);
      if (depth === null) {
        return null;
      }
      depths.push(depth);
    }
    return {
      state: state as QueueSourceState,
      instanceAlias: instanceAlias as string | null,
      depthCoverage: depthCoverage as QueueDepthCoverage,
      failure: failure as QueueSourceFailure,
      attempts,
      depths,
      next,
      lost,
      closed,
      droppedAttempts,
      evictedJobAliases,
    };
  } catch {
    return null;
  }
}

/** Copies one source status field by field. */
function projectStatus(status: QueueDiagnosticsSourceStatus): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    sourceId: status.sourceId,
    state: status.state,
    depthCoverage: status.depthCoverage,
    failure: status.failure,
    lost: status.lost,
    droppedAttempts: status.droppedAttempts,
    evictedJobAliases: status.evictedJobAliases,
  };
  if (status.instanceAlias !== undefined) {
    projected.instanceAlias = status.instanceAlias;
  }
  return projected;
}

/** Copies one merged attempt field by field. */
function projectAttempt(event: QueueAttemptObservation): Record<string, unknown> {
  return {
    sequence: event.sequence,
    sourceId: event.sourceId,
    instanceAlias: event.instanceAlias,
    queueAlias: event.queueAlias,
    jobAlias: event.jobAlias,
    attempt: event.attempt,
    durationMs: event.durationMs,
    outcome: event.outcome,
    settlement: event.settlement,
    ageMs: event.ageMs,
  };
}

/** Copies one merged depth field by field. */
function projectDepth(depth: QueueDepthObservation): Record<string, unknown> {
  return {
    sourceId: depth.sourceId,
    instanceAlias: depth.instanceAlias,
    queueAlias: depth.queueAlias,
    ready: depth.ready,
    processing: depth.processing,
    dead: depth.dead,
    scope: depth.scope,
    coverage: depth.coverage,
    ageMs: depth.ageMs,
  };
}

/**
 * Re-projects a merged queue batch against the exact M98f field allowlist —
 * the compact final JSON, not an envelope.
 *
 * @param batch - The merged batch
 * @returns The projected, serialization-ready record
 * @internal
 */
export function projectQueueBatch(batch: QueueDiagnosticsBatch): Record<string, unknown> {
  return {
    version: batch.version,
    instanceId: batch.instanceId,
    state: batch.state,
    sources: batch.sources.map(projectStatus),
    events: batch.events.map(projectAttempt),
    depths: batch.depths.map(projectDepth),
    next: batch.next,
    lost: batch.lost,
    truncatedSources: batch.truncatedSources,
    truncatedDepths: batch.truncatedDepths,
  };
}

const BATCH_KEYS: readonly string[] = [
  'version',
  'instanceId',
  'state',
  'sources',
  'events',
  'depths',
  'next',
  'lost',
  'truncatedSources',
  'truncatedDepths',
];
const STATUS_KEYS: readonly string[] = [
  'sourceId',
  'state',
  'depthCoverage',
  'failure',
  'lost',
  'droppedAttempts',
  'evictedJobAliases',
];
const ATTEMPT_KEYS: readonly string[] = [
  'sequence',
  'sourceId',
  'instanceAlias',
  'queueAlias',
  'jobAlias',
  'attempt',
  'durationMs',
  'outcome',
  'settlement',
  'ageMs',
];
const DEPTH_KEYS: readonly string[] = [
  'sourceId',
  'instanceAlias',
  'queueAlias',
  'ready',
  'processing',
  'dead',
  'scope',
  'coverage',
  'ageMs',
];

/** Validates one projected source status. */
function isStatusProjection(value: unknown, ids: Set<string>): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const hasAlias = Object.hasOwn(value, 'instanceAlias');
  if (!hasExactKeys(value, hasAlias ? [...STATUS_KEYS, 'instanceAlias'] : STATUS_KEYS)) {
    return false;
  }
  const sourceId = value.sourceId;
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId) || ids.has(sourceId)) {
    return false;
  }
  ids.add(sourceId);
  return isOneOf(value.state, STATUS_STATES) &&
    (!hasAlias || isDisplayAlias(value.instanceAlias)) &&
    isOneOf(value.depthCoverage, DEPTH_COVERAGES) &&
    isOneOf(value.failure, STATUS_FAILURES) &&
    isCount(value.lost) && isCount(value.droppedAttempts) && isCount(value.evictedJobAliases);
}

/** Validates one projected merged attempt. */
function isAttemptProjection(value: unknown, ids: Set<string>): boolean {
  return isRecord(value) && hasExactKeys(value, ATTEMPT_KEYS) &&
    isCount(value.sequence) && value.sequence >= 1 &&
    typeof value.sourceId === 'string' && ids.has(value.sourceId) &&
    isDisplayAlias(value.instanceAlias) && isDisplayAlias(value.queueAlias) &&
    typeof value.jobAlias === 'string' && JOB_ALIAS.test(value.jobAlias) &&
    isCount(value.attempt) && value.attempt >= 1 && isMs(value.durationMs) &&
    isOneOf(value.outcome, OUTCOMES) && isOneOf(value.settlement, SETTLEMENTS) &&
    isMs(value.ageMs);
}

/** Validates one projected merged depth. */
function isDepthProjection(value: unknown, ids: Set<string>): boolean {
  return isRecord(value) && hasExactKeys(value, DEPTH_KEYS) &&
    typeof value.sourceId === 'string' && ids.has(value.sourceId) &&
    isDisplayAlias(value.instanceAlias) && isDisplayAlias(value.queueAlias) &&
    isCount(value.ready) && isCount(value.processing) && isCount(value.dead) &&
    isOneOf(value.scope, SCOPES) && isOneOf(value.coverage, CYCLE_COVERAGES) &&
    isMs(value.ageMs);
}

/**
 * Reports whether a value is a well-formed M98f queue-batch projection:
 * EXACTLY the batch keys, version `1`, a non-empty instance string, a fixed
 * batch state, at most 16 uniquely-identified sources (none when
 * `unsupported`), at most 128 events with strictly increasing sequences past
 * the batch cursor, at most 1,024 depths, every event and depth naming a
 * listed source, and every field from its fixed vocabulary or bound.
 *
 * ONE validator for both sides of the wire: the connector runs it over its own
 * projection before signing, and the native client runs it again before
 * handing data to a consumer.
 *
 * @param value - The parsed JSON value, or a fresh projection
 * @returns `true` when the value is a well-formed queue batch
 * @internal
 */
export function isQueueBatchProjection(value: unknown): value is QueueDiagnosticsBatch {
  if (!isRecord(value) || !hasExactKeys(value, BATCH_KEYS)) {
    return false;
  }
  const { sources, events, depths } = value;
  if (
    value.version !== 1 || typeof value.instanceId !== 'string' || value.instanceId.length === 0 ||
    (value.state !== 'unsupported' && value.state !== 'ready') ||
    !Array.isArray(sources) || sources.length > MAX_QUEUE_SOURCES ||
    (value.state === 'unsupported') !== (sources.length === 0) ||
    !Array.isArray(events) || events.length > MAX_MERGED_EVENTS ||
    !Array.isArray(depths) || depths.length > MAX_QUEUE_SOURCES * MAX_SOURCE_DEPTHS ||
    !isCount(value.next) || !isCount(value.lost) ||
    !isCount(value.truncatedSources) || !isCount(value.truncatedDepths)
  ) {
    return false;
  }
  const ids = new Set<string>();
  if (!sources.every((status) => isStatusProjection(status, ids))) {
    return false;
  }
  if (!events.every((event) => isAttemptProjection(event, ids))) {
    return false;
  }
  for (let index = 1; index < events.length; index++) {
    if (
      (events[index] as { sequence: number }).sequence <= (events[index - 1] as {
        sequence: number;
      }).sequence
    ) {
      return false;
    }
  }
  if (events.length > 0) {
    const last = (events[events.length - 1] as { sequence: number }).sequence;
    if (value.next !== last) {
      return false;
    }
  }
  return depths.every((depth) => isDepthProjection(depth, ids));
}
