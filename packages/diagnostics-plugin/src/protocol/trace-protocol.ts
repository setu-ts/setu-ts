/**
 * Trace observation protocol (M98g): the exact validation of a trace
 * source's batch before the connector signs it, the field-by-field
 * projection of that batch, and the ONE validator both sides of the wire
 * run over it.
 *
 * A trace source is a registered capability, so its batch is untrusted
 * input to the connector: every field is read once, checked against its
 * fixed vocabulary or bound, and copied — never spread — so an unexpected
 * field, a throwing getter, an oversized alias, a malformed identifier or a
 * control character cannot reach the signed frame. Identifiers must match
 * the W3C lowercase-hex grammar and all-zero values are rejected.
 *
 * @module
 */

import type {
  TraceCoverage,
  TraceDiagnosticsBatch,
  TraceInstrumentationKind,
  TraceLinkRelationship,
  TraceObservation,
  TraceOutcome,
  TraceParentVisibility,
  TraceSourceState,
} from '@setu-ts/common';

import { hasExactKeys, isDisplayAlias, isRecord } from './protocol.ts';

/** The per-read record bound a source honours, and so a source batch's ceiling. */
const MAX_TRACE_RECORDS = 128;

/** The link budget per span — the same fixed eight the collector enforces. */
const MAX_TRACE_LINKS = 8;

const SOURCE_STATES: ReadonlySet<string> = new Set<TraceSourceState>([
  'disabled',
  'unsupported',
  'no-data',
  'ready',
  'collection-failed',
]);
const COVERAGE: ReadonlySet<string> = new Set<TraceCoverage>([
  'completed-sampled-spans',
  'custom-provider',
  'noop-no-provider',
  'unknown',
]);
const INSTRUMENTATION: ReadonlySet<string> = new Set<TraceInstrumentationKind>([
  'http',
  'fetch',
  'ioredis',
  'amqplib',
  'kafkajs',
]);
const OUTCOMES: ReadonlySet<string> = new Set<TraceOutcome>(['ok', 'error', 'unset']);
const VISIBILITIES: ReadonlySet<string> = new Set<TraceParentVisibility>([
  'observed',
  'remote-or-unobserved',
  'root',
  'unknown',
]);
const SPAN_KINDS: ReadonlySet<string> = new Set([
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
]);
const SAMPLER_KINDS: ReadonlySet<string> = new Set(['always-on', 'traceidratio', 'unknown']);

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const ALL_ZERO_TRACE_ID = '0'.repeat(32);
const ALL_ZERO_SPAN_ID = '0'.repeat(16);

/** A valid W3C trace id: 32 lowercase hex, never all-zero. */
function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value) &&
    value !== ALL_ZERO_TRACE_ID;
}

/** A valid W3C span id: 16 lowercase hex, never all-zero. */
function isSpanId(value: unknown): value is string {
  return typeof value === 'string' && SPAN_ID_PATTERN.test(value) && value !== ALL_ZERO_SPAN_ID;
}

/** A non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A finite, non-negative millisecond measurement. */
function isMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Copies a source-supplied list INDEX BY INDEX, reading its `length` once
 * and never more than `max + 1` items — never through the source's own
 * iterator, `map` or `toJSON`. An `Array` subclass (or a `Proxy` over one)
 * can report one `length` while its iterator yields any number of items,
 * including infinitely many; iterating it would let a replacement source
 * exceed the requested limit or hang the connector's event loop. Reading one
 * item past the budget is what lets the caller refuse an over-budget list
 * rather than silently truncate it (the M98e re-audit precedent).
 *
 * @param value - The candidate list
 * @param max - The budget
 * @returns The copied items (at most `max + 1`), or `null` for a non-array
 */
function copyBounded(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const length = Math.min(value.length, max + 1);
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    copy.push(value[index]);
  }
  return copy;
}

/** Membership in a fixed vocabulary. */
function isOneOf(value: unknown, vocabulary: ReadonlySet<string>): value is string {
  return typeof value === 'string' && vocabulary.has(value);
}

/**
 * One validated trace observation, copied field by field.
 *
 * @internal
 */
export interface ValidatedTraceObservation {
  readonly sequence: number;
  readonly serviceAlias: string;
  readonly operationAlias: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly links: readonly TraceLinkRelationship[];
  readonly kind: TraceObservation['kind'];
  readonly outcome: TraceOutcome;
  readonly durationMs: number;
  readonly ageMs: number;
  readonly parentVisibility: TraceParentVisibility;
}

/**
 * One validated source batch, copied field by field.
 *
 * @internal
 */
export interface ValidatedTraceBatch {
  readonly state: TraceSourceState;
  readonly coverage: TraceCoverage;
  readonly instrumentation: readonly TraceInstrumentationKind[];
  readonly sampler: { readonly kind: string; readonly ratio: number | null };
  readonly records: readonly ValidatedTraceObservation[];
  readonly next: number;
  readonly lost: number;
  readonly closed: boolean;
  readonly droppedSpans: number;
}

const BATCH_KEYS: readonly string[] = [
  'version',
  'instanceId',
  'state',
  'coverage',
  'instrumentation',
  'sampler',
  'records',
  'next',
  'lost',
  'closed',
  'droppedSpans',
];
const RECORD_KEYS: readonly string[] = [
  'sequence',
  'serviceAlias',
  'operationAlias',
  'traceId',
  'spanId',
  'links',
  'kind',
  'outcome',
  'durationMs',
  'ageMs',
  'parentVisibility',
];
const LINK_KEYS: readonly string[] = ['traceId', 'spanId'];

/** Validates and copies one link relationship. */
function readLink(value: unknown): TraceLinkRelationship | null {
  if (!isRecord(value) || !hasExactKeys(value, LINK_KEYS)) {
    return null;
  }
  const { traceId, spanId } = value;
  return isTraceId(traceId) && isSpanId(spanId) ? { traceId, spanId } : null;
}

/**
 * Validates and copies one span observation. Every field is read EXACTLY
 * once into a local, validated there, and the copy is built from those
 * locals — a getter that answers differently on a second read never reaches
 * the copy.
 */
function readRecord(value: unknown): ValidatedTraceObservation | null {
  if (!isRecord(value)) {
    return null;
  }
  const visibility = value.parentVisibility;
  if (!isOneOf(visibility, VISIBILITIES)) {
    return null;
  }
  // `parentSpanId` is present exactly when the visibility says the parent
  // identifier is locally meaningful.
  const parentKnown = visibility === 'observed' || visibility === 'remote-or-unobserved';
  const keys = parentKnown ? [...RECORD_KEYS, 'parentSpanId'] : RECORD_KEYS;
  if (!hasExactKeys(value, keys)) {
    return null;
  }
  let parentSpanId: string | null = null;
  if (parentKnown) {
    const raw = value.parentSpanId;
    if (!isSpanId(raw)) {
      return null;
    }
    parentSpanId = raw;
  }
  const rawLinks = copyBounded(value.links, MAX_TRACE_LINKS);
  if (rawLinks === null || rawLinks.length > MAX_TRACE_LINKS) {
    return null;
  }
  const links: TraceLinkRelationship[] = [];
  for (const raw of rawLinks) {
    const link = readLink(raw);
    if (link === null) {
      return null;
    }
    links.push(link);
  }
  const {
    sequence,
    serviceAlias,
    operationAlias,
    traceId,
    spanId,
    kind,
    outcome,
    durationMs,
    ageMs,
  } = value;
  if (
    !isCount(sequence) || sequence < 1 ||
    !isDisplayAlias(serviceAlias) || !isDisplayAlias(operationAlias) ||
    !isTraceId(traceId) || !isSpanId(spanId) ||
    !isOneOf(kind, SPAN_KINDS) || !isOneOf(outcome, OUTCOMES) ||
    !isMs(durationMs) || !isMs(ageMs)
  ) {
    return null;
  }
  return {
    sequence,
    serviceAlias,
    operationAlias,
    traceId,
    spanId,
    parentSpanId,
    links,
    kind: kind as TraceObservation['kind'],
    outcome: outcome as TraceOutcome,
    durationMs,
    ageMs,
    parentVisibility: visibility as TraceParentVisibility,
  };
}

/** Validates and copies the sampler description. */
function readSampler(value: unknown): { kind: string; ratio: number | null } | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  if (!isOneOf(kind, SAMPLER_KINDS)) {
    return null;
  }
  if (kind === 'traceidratio') {
    const hasRatio = Object.hasOwn(value, 'ratio');
    // `ratio` is present exactly when the kind is `traceidratio`, and is a
    // finite number in the sampler's [0, 1] domain.
    if (!hasExactKeys(value, hasRatio ? ['kind', 'ratio'] : ['kind']) || !hasRatio) {
      return null;
    }
    const ratio = value.ratio;
    return typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
      ? { kind, ratio }
      : null;
  }
  if (!hasExactKeys(value, ['kind'])) {
    return null;
  }
  return { kind, ratio: null };
}

/**
 * Validates an untrusted trace source batch against the exact M98g DTO and
 * the M98a cursor contract for the cursor the connector requested, and
 * returns a field-by-field copy.
 *
 * Refused: any unknown, missing or extra key; a value outside its fixed
 * vocabulary or bound; an alias outside the display shape; an identifier
 * outside the W3C lowercase-hex grammar or all-zero; a `disabled` or
 * `unsupported` batch carrying any record; a closed batch carrying any
 * record; more records than the requested limit; sequences not strictly
 * increasing past the cursor; and a `next`/`lost` pair disagreeing with the
 * returned records. Any throw while reading — a hostile getter — is a
 * refusal too.
 *
 * @param value - The batch the source returned
 * @param instanceId - The instance UUID the connector requested
 * @param cursor - The exclusive cursor the connector requested
 * @param limit - The record bound the connector requested
 * @returns The validated copy, or `null` for any violation
 * @internal
 */
export function readTraceSourceBatch(
  value: unknown,
  instanceId: string,
  cursor: number,
  limit: number,
): ValidatedTraceBatch | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, BATCH_KEYS) || value.version !== 1) {
      return null;
    }
    if (value.instanceId !== instanceId) {
      return null;
    }
    const state = value.state;
    if (!isOneOf(state, SOURCE_STATES)) {
      return null;
    }
    const coverage = value.coverage;
    if (!isOneOf(coverage, COVERAGE)) {
      return null;
    }
    // Five families, each at most once: a sixth item is a duplicate by
    // construction and refuses below.
    const rawInstrumentation = copyBounded(value.instrumentation, INSTRUMENTATION.size);
    if (rawInstrumentation === null) {
      return null;
    }
    const instrumentation: TraceInstrumentationKind[] = [];
    const seenKinds = new Set<string>();
    for (const kind of rawInstrumentation) {
      if (!isOneOf(kind, INSTRUMENTATION) || seenKinds.has(kind)) {
        return null;
      }
      seenKinds.add(kind);
      instrumentation.push(kind as TraceInstrumentationKind);
    }
    const sampler = readSampler(value.sampler);
    if (sampler === null) {
      return null;
    }
    const { next, lost, closed, droppedSpans } = value;
    const rawRecords = copyBounded(value.records, limit);
    if (
      rawRecords === null || rawRecords.length > limit ||
      !isCount(next) || !isCount(lost) || typeof closed !== 'boolean' ||
      !isCount(droppedSpans)
    ) {
      return null;
    }
    // A source that observes nothing retains nothing: `disabled` and
    // `unsupported` observe by definition, and a closed source has cleared
    // its ring.
    if (
      (state === 'disabled' || state === 'unsupported' || closed) && rawRecords.length > 0
    ) {
      return null;
    }
    const records: ValidatedTraceObservation[] = [];
    let previous = cursor;
    for (const raw of rawRecords) {
      const record = readRecord(raw);
      if (record === null || record.sequence <= previous) {
        return null;
      }
      previous = record.sequence;
      records.push(record);
    }
    const expectedNext = records.length > 0 ? records[records.length - 1]!.sequence : cursor;
    const expectedLost = records.length > 0 ? records[0]!.sequence - cursor - 1 : 0;
    if (next !== expectedNext || lost !== expectedLost) {
      return null;
    }
    return {
      state: state as TraceSourceState,
      coverage: coverage as TraceCoverage,
      instrumentation,
      sampler,
      records,
      next,
      lost,
      closed,
      droppedSpans,
    };
  } catch {
    return null;
  }
}

/** Copies one validated record field by field. */
function projectRecord(record: ValidatedTraceObservation): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    sequence: record.sequence,
    serviceAlias: record.serviceAlias,
    operationAlias: record.operationAlias,
    traceId: record.traceId,
    spanId: record.spanId,
    links: record.links.map((link) => ({ traceId: link.traceId, spanId: link.spanId })),
    kind: record.kind,
    outcome: record.outcome,
    durationMs: record.durationMs,
    ageMs: record.ageMs,
    parentVisibility: record.parentVisibility,
  };
  if (record.parentSpanId !== null) {
    projected.parentSpanId = record.parentSpanId;
  }
  return projected;
}

/**
 * Projects a validated trace batch into the serialization-ready record —
 * the compact final JSON, not an envelope.
 *
 * @param batch - The validated batch
 * @param instanceId - The bound instance UUID the batch was read for
 * @returns The projected, serialization-ready record
 * @internal
 */
export function projectTraceBatch(
  batch: ValidatedTraceBatch,
  instanceId: string,
): Record<string, unknown> {
  const sampler: Record<string, unknown> = { kind: batch.sampler.kind };
  if (batch.sampler.ratio !== null) {
    sampler.ratio = batch.sampler.ratio;
  }
  return {
    version: 1,
    instanceId,
    state: batch.state,
    coverage: batch.coverage,
    instrumentation: [...batch.instrumentation],
    sampler,
    records: batch.records.map(projectRecord),
    next: batch.next,
    lost: batch.lost,
    closed: batch.closed,
    droppedSpans: batch.droppedSpans,
  };
}

const PROJECTION_KEYS: readonly string[] = [
  'version',
  'instanceId',
  'state',
  'coverage',
  'instrumentation',
  'sampler',
  'records',
  'next',
  'lost',
  'closed',
  'droppedSpans',
];
const PROJECTION_RECORD_KEYS: readonly string[] = [
  'sequence',
  'serviceAlias',
  'operationAlias',
  'traceId',
  'spanId',
  'links',
  'kind',
  'outcome',
  'durationMs',
  'ageMs',
  'parentVisibility',
];

/** Validates one projected record against the exact M98g DTO. */
function isRecordProjection(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const visibility = value.parentVisibility;
  if (!isOneOf(visibility, VISIBILITIES)) {
    return false;
  }
  const parentKnown = visibility === 'observed' || visibility === 'remote-or-unobserved';
  const keys = parentKnown ? [...PROJECTION_RECORD_KEYS, 'parentSpanId'] : PROJECTION_RECORD_KEYS;
  if (!hasExactKeys(value, keys)) {
    return false;
  }
  const links = value.links;
  if (!Array.isArray(links) || links.length > MAX_TRACE_LINKS) {
    return false;
  }
  return isCount(value.sequence) && value.sequence >= 1 &&
    isDisplayAlias(value.serviceAlias) && isDisplayAlias(value.operationAlias) &&
    isTraceId(value.traceId) && isSpanId(value.spanId) &&
    (!parentKnown || isSpanId(value.parentSpanId)) &&
    links.every((link) =>
      isRecord(link) && hasExactKeys(link, LINK_KEYS) && isTraceId(link.traceId) &&
      isSpanId(link.spanId)
    ) &&
    isOneOf(value.kind, SPAN_KINDS) && isOneOf(value.outcome, OUTCOMES) &&
    isMs(value.durationMs) && isMs(value.ageMs);
}

/** Validates one projected sampler description. */
function isSamplerProjection(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const kind = value.kind;
  if (!isOneOf(kind, SAMPLER_KINDS)) {
    return false;
  }
  if (kind === 'traceidratio') {
    const hasRatio = Object.hasOwn(value, 'ratio');
    return hasExactKeys(value, hasRatio ? ['kind', 'ratio'] : ['kind']) && hasRatio &&
      typeof value.ratio === 'number' && Number.isFinite(value.ratio) &&
      value.ratio >= 0 && value.ratio <= 1;
  }
  return hasExactKeys(value, ['kind']);
}

/**
 * Reports whether a value is a well-formed M98g trace-batch projection:
 * EXACTLY the batch keys, version `1`, a non-empty instance string, a fixed
 * state, coverage, sampler, at most 128 records with strictly increasing
 * sequences, and every field from its fixed vocabulary or bound.
 *
 * ONE validator for both sides of the wire: the connector runs it over its
 * own projection before signing, and the native client runs it again before
 * handing data to a consumer.
 *
 * @param value - The parsed JSON value, or a fresh projection
 * @returns `true` when the value is a well-formed trace batch
 * @internal
 */
export function isTraceBatchProjection(value: unknown): value is TraceDiagnosticsBatch {
  if (!isRecord(value) || !hasExactKeys(value, PROJECTION_KEYS)) {
    return false;
  }
  const records = value.records;
  if (
    value.version !== 1 || typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0 ||
    !isOneOf(value.state, SOURCE_STATES) || !isOneOf(value.coverage, COVERAGE) ||
    !Array.isArray(value.instrumentation) ||
    !value.instrumentation.every((kind) => isOneOf(kind, INSTRUMENTATION)) ||
    new Set(value.instrumentation as string[]).size !==
      (value.instrumentation as unknown[]).length ||
    !isSamplerProjection(value.sampler) ||
    !Array.isArray(records) || records.length > MAX_TRACE_RECORDS ||
    !isCount(value.next) || !isCount(value.lost) ||
    typeof value.closed !== 'boolean' || !isCount(value.droppedSpans)
  ) {
    return false;
  }
  if (!records.every(isRecordProjection)) {
    return false;
  }
  for (let index = 1; index < records.length; index++) {
    if (
      (records[index] as { sequence: number }).sequence <=
        (records[index - 1] as { sequence: number }).sequence
    ) {
      return false;
    }
  }
  if (records.length > 0) {
    const last = (records[records.length - 1] as { sequence: number }).sequence;
    if (value.next !== last) {
      return false;
    }
  }
  return true;
}
