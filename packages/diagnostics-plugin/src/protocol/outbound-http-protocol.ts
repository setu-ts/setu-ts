/**
 * Outbound HTTP observation protocol (M98n): the exact, copy-once reading of
 * every registered outbound HTTP source's snapshot, the aggregate response the
 * connector signs for `GET /v1/outbound-http`, and the ONE validator both
 * sides of the wire run over it.
 *
 * A source is a multi-provider contribution any installed plugin can
 * register, so its snapshot is untrusted input: only plain objects carrying
 * own DATA properties are admitted, every field is copied individually, a
 * throwing proxy trap is caught, and every snapshot invariant is checked. A
 * source failing any check is reported as a fixed `collection-failed`
 * snapshot carrying no records and no error text.
 *
 * @module
 */

import type {
  DiagnosticsInspectorState,
  IOutboundHttpDiagnosticsSource,
  OutboundHttpDiagnosticsResponse,
  OutboundHttpDiagnosticsSnapshot,
} from '@setu-ts/common';

import {
  copyOwnData,
  copyOwnDataList,
  hasExactKeys,
  isDisplayAlias,
  isRecord,
} from './protocol.ts';

/**
 * The fixed source bound: a connector refuses to start with more outbound
 * HTTP sources than this.
 *
 * @internal
 */
export const MAX_OUTBOUND_HTTP_SOURCES = 16;

/** A source holds at most one record. */
const MAX_OUTBOUND_HTTP_RECORDS = 1;

/** The fixed response budget, in UTF-8 bytes of the compact JSON. */
const MAX_OUTBOUND_HTTP_RESPONSE_BYTES = 256 * 1024;

const STATUS_CLASSES: ReadonlySet<string> = new Set(['2xx', '3xx', '4xx', '5xx', 'other']);

/** States a SOURCE may report about itself (`unsupported` is connector-side only). */
const SOURCE_STATES: ReadonlySet<string> = new Set<DiagnosticsInspectorState>([
  'disabled',
  'no-data',
  'ready',
  'stale',
  'collection-failed',
]);

/** Aggregate state priority when at least one source exists. */
const STATE_PRIORITY: readonly DiagnosticsInspectorState[] = [
  'ready',
  'collection-failed',
  'stale',
  'no-data',
  'disabled',
];

const SNAPSHOT_KEYS: readonly string[] = ['state', 'alias', 'coverage', 'records'];

const RECORD_KEYS: readonly string[] = [
  'alias',
  'operation',
  'started',
  'count',
  'responses',
  'failures',
  'lastStatusClass',
  'lastDurationMs',
  'ageMs',
];

const COUNTER_KEYS = ['started', 'count', 'responses', 'failures', 'ageMs'] as const;

const RESPONSE_KEYS: readonly string[] = ['version', 'instanceId', 'state', 'sources'];
const ENTRY_KEYS: readonly string[] = ['sourceId', 'snapshot'];

const ENCODER = new TextEncoder();

/** A non-negative safe integer. */
function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates one record: exact keys, the snapshot's alias, the fixed
 * operation and status vocabulary, counters, and the counting invariants.
 *
 * @param value - The candidate record
 * @param alias - The owning snapshot's alias
 * @returns `true` when the record is well formed
 */
function isRecordProjection(value: unknown, alias: string): boolean {
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) {
    return false;
  }
  if (value.alias !== alias || value.operation !== 'attempt') {
    return false;
  }
  if (!COUNTER_KEYS.every((key) => isCounter(value[key]))) {
    return false;
  }
  const started = value.started as number;
  const count = value.count as number;
  const responses = value.responses as number;
  const failures = value.failures as number;
  if (count > started || responses + failures !== count) {
    return false;
  }
  const statusClass = value.lastStatusClass;
  if (statusClass === null) {
    if (responses !== 0) {
      return false;
    }
  } else if (
    typeof statusClass !== 'string' || !STATUS_CLASSES.has(statusClass) || responses === 0
  ) {
    return false;
  }
  const duration = value.lastDurationMs;
  if (duration === null) {
    return count === 0;
  }
  return isCounter(duration) && count > 0;
}

/**
 * Validates one copied snapshot against the exact contract and its state
 * rules.
 *
 * @param value - The candidate snapshot
 * @returns `true` when the snapshot is well formed
 * @internal
 */
export function isOutboundHttpSnapshotProjection(
  value: unknown,
): value is OutboundHttpDiagnosticsSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    return false;
  }
  if (typeof value.state !== 'string' || !SOURCE_STATES.has(value.state)) {
    return false;
  }
  if (value.coverage !== 'owned-instance') {
    return false;
  }
  const disabled = value.state === 'disabled';
  // A disabled source has no alias; a collection-failed one may carry its
  // approved alias or none (the connector's fixed failed snapshot); every
  // other state carries its approved alias.
  const aliasAllowedNull = disabled || value.state === 'collection-failed';
  if (value.alias === null ? !aliasAllowedNull : disabled || !isDisplayAlias(value.alias)) {
    return false;
  }
  const records = value.records;
  if (!Array.isArray(records) || records.length > MAX_OUTBOUND_HTTP_RECORDS) {
    return false;
  }
  if (value.state === 'ready' || value.state === 'stale') {
    return records.length === 1 && isRecordProjection(records[0], value.alias as string);
  }
  return records.length === 0;
}

/**
 * The fixed snapshot a source answers when its read threw or failed
 * validation: no alias, no records, no error text.
 *
 * @returns A fresh value-free snapshot
 */
function failedSourceSnapshot(): Record<string, unknown> {
  return { state: 'collection-failed', alias: null, coverage: 'owned-instance', records: [] };
}

/**
 * Reads one source, copying and validating its snapshot. Any throw or
 * contract violation yields the fixed failed snapshot.
 *
 * @param source - The registered source
 * @returns The validated copy, or the fixed failed snapshot
 */
function readSource(source: IOutboundHttpDiagnosticsSource): Record<string, unknown> {
  try {
    const raw: unknown = source.snapshot();
    const copy = copyOwnData(raw, SNAPSHOT_KEYS);
    if (copy === null) {
      return failedSourceSnapshot();
    }
    const records = copyOwnDataList(copy.records, MAX_OUTBOUND_HTTP_RECORDS, RECORD_KEYS);
    if (records === null) {
      return failedSourceSnapshot();
    }
    copy.records = records;
    return isOutboundHttpSnapshotProjection(copy) ? copy : failedSourceSnapshot();
  } catch {
    return failedSourceSnapshot();
  }
}

/**
 * The aggregate state over the per-source states.
 *
 * @param states - Each source's state
 * @returns `unsupported` with no source, otherwise the highest-priority state present
 */
function aggregateState(states: readonly string[]): DiagnosticsInspectorState {
  if (states.length === 0) {
    return 'unsupported';
  }
  for (const state of STATE_PRIORITY) {
    if (states.includes(state)) {
      return state;
    }
  }
  return 'collection-failed';
}

/**
 * The fixed, value-free response a whole read collapses to.
 *
 * @param instanceId - The session's bound instance UUID
 * @returns The response record
 */
function failedResponse(instanceId: string): Record<string, unknown> {
  return { version: 1, instanceId, state: 'collection-failed', sources: [] };
}

/**
 * Builds the signed-ready `GET /v1/outbound-http` response from every
 * registered source. Sources are read only here — after the request
 * authenticated — and each read is isolated. Duplicate non-null aliases, or a
 * compact JSON body over 256 KiB, collapse the whole response to a fixed
 * `collection-failed` with no sources.
 *
 * @param instanceId - The session's bound instance UUID
 * @param sources - The sources resolved at bootstrap, in registration order
 * @param budgetBytes - The response budget (a test seam; defaults to 256 KiB)
 * @returns The response record
 * @internal
 */
export function buildOutboundHttpResponse(
  instanceId: string,
  sources: readonly IOutboundHttpDiagnosticsSource[],
  budgetBytes: number = MAX_OUTBOUND_HTTP_RESPONSE_BYTES,
): Record<string, unknown> {
  const entries: Record<string, unknown>[] = [];
  const aliases = new Set<string>();
  const states: string[] = [];
  for (let index = 0; index < sources.length; index++) {
    const snapshot = readSource(sources[index] as IOutboundHttpDiagnosticsSource);
    const alias = snapshot.alias;
    if (typeof alias === 'string') {
      if (aliases.has(alias)) {
        return failedResponse(instanceId);
      }
      aliases.add(alias);
    }
    states.push(snapshot.state as string);
    entries.push({ sourceId: `s${index + 1}`, snapshot });
  }
  const response = { version: 1, instanceId, state: aggregateState(states), sources: entries };
  if (ENCODER.encode(JSON.stringify(response)).byteLength > budgetBytes) {
    return failedResponse(instanceId);
  }
  return response;
}

/**
 * The ONE validator both sides of the wire run over an outbound HTTP
 * response.
 *
 * @param value - The candidate response
 * @returns `true` when the response is well formed
 * @internal
 */
export function isOutboundHttpResponseProjection(
  value: unknown,
): value is OutboundHttpDiagnosticsResponse {
  if (!isRecord(value) || !hasExactKeys(value, RESPONSE_KEYS)) {
    return false;
  }
  if (value.version !== 1 || typeof value.instanceId !== 'string' || value.instanceId === '') {
    return false;
  }
  const sources = value.sources;
  if (!Array.isArray(sources) || sources.length > MAX_OUTBOUND_HTTP_SOURCES) {
    return false;
  }
  const aliases = new Set<string>();
  const states: string[] = [];
  for (let index = 0; index < sources.length; index++) {
    const entry: unknown = sources[index];
    if (!isRecord(entry) || !hasExactKeys(entry, ENTRY_KEYS)) {
      return false;
    }
    if (entry.sourceId !== `s${index + 1}` || !isOutboundHttpSnapshotProjection(entry.snapshot)) {
      return false;
    }
    const alias = entry.snapshot.alias;
    if (alias !== null) {
      if (aliases.has(alias)) {
        return false;
      }
      aliases.add(alias);
    }
    states.push(entry.snapshot.state);
  }
  if (sources.length === 0 && value.state === 'collection-failed') {
    return true;
  }
  return value.state === aggregateState(states);
}
