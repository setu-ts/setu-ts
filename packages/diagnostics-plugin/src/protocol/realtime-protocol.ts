/**
 * Realtime observation protocol (M98l): the exact, copy-once reading of every
 * registered realtime source's snapshot, the aggregate response the connector
 * signs for `GET /v1/realtime`, and the ONE validator both sides of the wire
 * run over it.
 *
 * A realtime source is a multi-provider contribution any installed plugin can
 * register, so its snapshot is untrusted input: only plain objects carrying
 * own DATA properties are admitted (a getter, a custom prototype or an extra
 * key refuses the source), every field — the nested `gauges` included — is
 * read once and copied individually, and a throwing proxy trap is caught. On
 * top of the field shapes, the validator enforces the combinations the
 * contract fixes: which operations a kind admits, which gauge state a kind and
 * a source state require, and that only an `sse` `close` record carries a
 * backpressure count. A source that fails any check is reported as a fixed,
 * value-free `collection-failed` snapshot of kind `unknown` — the one place
 * `unknown` may appear, and a kind no source may claim for itself.
 *
 * @module
 */

import type {
  DiagnosticsInspectorState,
  IRealtimeDiagnosticsSource,
  RealtimeDiagnosticsResponse,
  RealtimeDiagnosticsSnapshot,
  RealtimeObservationOperation,
  RealtimeSourceKind,
} from '@setu-ts/common';

import {
  copyOwnData,
  copyOwnDataList,
  hasExactKeys,
  isDisplayAlias,
  isRecord,
} from './protocol.ts';

/**
 * The fixed source bound: a connector refuses to start with more realtime
 * sources than this.
 *
 * @internal
 */
export const MAX_REALTIME_SOURCES = 16;

/** The fixed per-source record bound of the shared contract. */
const MAX_REALTIME_RECORDS = 64;

/** The fixed response budget, in UTF-8 bytes of the compact JSON. */
const MAX_REALTIME_RESPONSE_BYTES = 256 * 1024;

/** The operations each kind admits. */
const KIND_OPERATIONS: Readonly<Record<RealtimeSourceKind, ReadonlySet<string>>> = {
  websocket: new Set<RealtimeObservationOperation>(['open', 'close', 'send']),
  sse: new Set<RealtimeObservationOperation>(['open', 'close', 'send']),
  backplane: new Set<RealtimeObservationOperation>(['backplane-publish', 'backplane-receive']),
};

/** States a SOURCE may report about itself (`unsupported` is connector-side only). */
const SOURCE_STATES: ReadonlySet<string> = new Set<DiagnosticsInspectorState>([
  'disabled',
  'no-data',
  'ready',
  'stale',
  'collection-failed',
]);

const GAUGE_STATES: ReadonlySet<string> = new Set([
  'available',
  'unsupported',
  'disabled',
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

const SNAPSHOT_KEYS: readonly string[] = [
  'state',
  'alias',
  'sourceKind',
  'coverage',
  'gauges',
  'records',
  'dropped',
];
const GAUGE_KEYS: readonly string[] = ['state', 'openConnections', 'groups'];
const RECORD_KEYS: readonly string[] = [
  'alias',
  'operation',
  'count',
  'lastDurationMs',
  'ageMs',
  'succeeded',
  'failed',
  'backpressureCloses',
];
const RESPONSE_KEYS: readonly string[] = ['version', 'instanceId', 'state', 'sources'];
const ENTRY_KEYS: readonly string[] = ['sourceId', 'snapshot'];

const ENCODER = new TextEncoder();

/** A non-negative safe integer. */
function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Whether a string names a built-in source kind. */
function isSourceKind(value: unknown): value is RealtimeSourceKind {
  return value === 'websocket' || value === 'sse' || value === 'backplane';
}

/**
 * Validates the gauges against the snapshot's kind and state: `disabled` and
 * `collection-failed` sources carry matching unread gauges; an enabled
 * websocket or sse source carries `available` gauges with two counters; an
 * enabled backplane carries `unsupported` ones. Every unread state carries
 * `null` for both values.
 */
function isGaugesProjection(
  value: unknown,
  kind: RealtimeSourceKind,
  state: string,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, GAUGE_KEYS)) {
    return false;
  }
  const gaugeState = value.state;
  if (typeof gaugeState !== 'string' || !GAUGE_STATES.has(gaugeState)) {
    return false;
  }
  if (gaugeState === 'available') {
    if (!isCounter(value.openConnections) || !isCounter(value.groups)) {
      return false;
    }
  } else if (value.openConnections !== null || value.groups !== null) {
    return false;
  }
  if (state === 'disabled' || state === 'collection-failed') {
    return gaugeState === state;
  }
  return kind === 'backplane' ? gaugeState === 'unsupported' : gaugeState === 'available';
}

/**
 * Validates one record: the exact keys, the snapshot's own alias, an
 * operation the kind admits, non-negative safe-integer counters, a duration
 * only on `backplane-publish`, and a backpressure count only on an `sse`
 * `close`.
 */
function isRecordProjection(value: unknown, alias: string, kind: RealtimeSourceKind): boolean {
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) {
    return false;
  }
  const operation = value.operation;
  if (
    value.alias !== alias || typeof operation !== 'string' ||
    !KIND_OPERATIONS[kind].has(operation)
  ) {
    return false;
  }
  if (
    !isCounter(value.count) || !isCounter(value.ageMs) ||
    !isCounter(value.succeeded) || !isCounter(value.failed)
  ) {
    return false;
  }
  const timed = operation === 'backplane-publish';
  if (value.lastDurationMs !== null && !(timed && isCounter(value.lastDurationMs))) {
    return false;
  }
  const pressured = kind === 'sse' && operation === 'close';
  return pressured ? isCounter(value.backpressureCloses) : value.backpressureCloses === null;
}

/**
 * Whether a snapshot is exactly the connector's value-free substitute for an
 * unreadable source.
 */
function isSyntheticFailure(value: Record<string, unknown>): boolean {
  const gauges = value.gauges;
  return value.state === 'collection-failed' && value.alias === null &&
    value.coverage === 'owned-instance' && value.dropped === 0 &&
    Array.isArray(value.records) && value.records.length === 0 &&
    isRecord(gauges) && hasExactKeys(gauges, GAUGE_KEYS) &&
    gauges.state === 'collection-failed' && gauges.openConnections === null &&
    gauges.groups === null;
}

/**
 * Validates one snapshot against the exact contract, including the
 * kind/operation, kind/gauge and state/gauge combinations.
 *
 * @param value - The candidate snapshot
 * @param allowUnknown - `true` only on the wire, where the connector's own
 * synthetic `unknown` snapshot may appear; a source may never claim it
 * @returns `true` when the snapshot is well formed
 * @internal
 */
export function isRealtimeSnapshotProjection(
  value: unknown,
  allowUnknown: boolean,
): value is RealtimeDiagnosticsSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    return false;
  }
  const kind = value.sourceKind;
  if (kind === 'unknown') {
    return allowUnknown && isSyntheticFailure(value);
  }
  if (!isSourceKind(kind)) {
    return false;
  }
  const state = value.state;
  if (typeof state !== 'string' || !SOURCE_STATES.has(state)) {
    return false;
  }
  if (value.coverage !== 'owned-instance' || !isCounter(value.dropped)) {
    return false;
  }
  // A websocket or sse source that is observing is always `ready`: its gauges
  // are current even with no retained record. Only a backplane reports
  // `no-data` or `stale`, from record age.
  if (kind !== 'backplane' && (state === 'no-data' || state === 'stale')) {
    return false;
  }
  const disabled = state === 'disabled';
  const aliasAllowedNull = disabled || state === 'collection-failed';
  if (value.alias === null ? !aliasAllowedNull : disabled || !isDisplayAlias(value.alias)) {
    return false;
  }
  if (!isGaugesProjection(value.gauges, kind, state)) {
    return false;
  }
  const records = value.records;
  if (!Array.isArray(records) || records.length > MAX_REALTIME_RECORDS) {
    return false;
  }
  const empty = disabled || state === 'collection-failed' || state === 'no-data';
  if (empty && records.length !== 0) {
    return false;
  }
  if (kind === 'backplane' && (state === 'ready' || state === 'stale') && records.length === 0) {
    return false;
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (!isRecordProjection(record, value.alias as string, kind)) {
      return false;
    }
    const operation = (record as { operation: string }).operation;
    if (seen.has(operation)) {
      return false;
    }
    seen.add(operation);
  }
  return true;
}

/**
 * The fixed snapshot a source answers when its read threw or failed
 * validation: kind `unknown`, no alias, failed gauges, no records, no error
 * text. No kind or alias is ever salvaged from the refused read.
 *
 * @returns A fresh value-free snapshot
 */
function failedSourceSnapshot(): Record<string, unknown> {
  return {
    state: 'collection-failed',
    alias: null,
    sourceKind: 'unknown',
    coverage: 'owned-instance',
    gauges: { state: 'collection-failed', openConnections: null, groups: null },
    records: [],
    dropped: 0,
  };
}

/**
 * Reads one source, copying and validating its snapshot. Any throw — a
 * source fault, a proxy trap, a getter — or any contract violation yields
 * the fixed failed snapshot.
 *
 * @param source - The registered source
 * @returns The validated copy, or the fixed failed snapshot
 */
function readSource(source: IRealtimeDiagnosticsSource): Record<string, unknown> {
  try {
    const raw: unknown = source.snapshot();
    const copy = copyOwnData(raw, SNAPSHOT_KEYS);
    if (copy === null) {
      return failedSourceSnapshot();
    }
    const gauges = copyOwnData(copy.gauges, GAUGE_KEYS);
    const records = copyOwnDataList(copy.records, MAX_REALTIME_RECORDS, RECORD_KEYS);
    if (gauges === null || records === null) {
      return failedSourceSnapshot();
    }
    copy.gauges = gauges;
    copy.records = records;
    return isRealtimeSnapshotProjection(copy, false) ? copy : failedSourceSnapshot();
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
  // Every validated source state is in the priority list, so a non-empty list
  // always matches one.
  return STATE_PRIORITY.find((state) => states.includes(state)) as DiagnosticsInspectorState;
}

/**
 * The fixed, value-free response a whole read collapses to: duplicate
 * aliases, or a body over the budget.
 *
 * @param instanceId - The session's bound instance UUID
 * @returns The response record
 */
function failedResponse(instanceId: string): Record<string, unknown> {
  return { version: 1, instanceId, state: 'collection-failed', sources: [] };
}

/**
 * Builds the signed-ready `GET /v1/realtime` response from every registered
 * source. Sources are read only here — after the request authenticated —
 * and each read is isolated. Duplicate non-null aliases collapse the whole
 * response to a fixed `collection-failed` with no sources, and so does a
 * response whose compact JSON would exceed 256 KiB: a partial document is
 * never produced.
 *
 * @param instanceId - The session's bound instance UUID
 * @param sources - The sources resolved at bootstrap, in registration order
 * @returns The response record
 * @internal
 */
export function buildRealtimeResponse(
  instanceId: string,
  sources: readonly IRealtimeDiagnosticsSource[],
): Record<string, unknown> {
  const entries: Record<string, unknown>[] = [];
  const aliases = new Set<string>();
  const states: string[] = [];
  for (let index = 0; index < sources.length; index++) {
    const snapshot = readSource(sources[index] as IRealtimeDiagnosticsSource);
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
  const response = {
    version: 1,
    instanceId,
    state: aggregateState(states),
    sources: entries,
  };
  if (ENCODER.encode(JSON.stringify(response)).byteLength > MAX_REALTIME_RESPONSE_BYTES) {
    return failedResponse(instanceId);
  }
  return response;
}

/**
 * The ONE validator both sides of the wire run over a realtime response: the
 * exact keys, sequential `s<N>` source ids within the source bound, every
 * snapshot's exact contract and combinations, unique non-null aliases, and an
 * aggregate state consistent with the per-source states.
 *
 * @param value - The candidate response
 * @returns `true` when the response is well formed
 * @internal
 */
export function isRealtimeResponseProjection(
  value: unknown,
): value is RealtimeDiagnosticsResponse {
  if (!isRecord(value) || !hasExactKeys(value, RESPONSE_KEYS)) {
    return false;
  }
  if (value.version !== 1 || typeof value.instanceId !== 'string' || value.instanceId === '') {
    return false;
  }
  const sources = value.sources;
  if (!Array.isArray(sources) || sources.length > MAX_REALTIME_SOURCES) {
    return false;
  }
  const aliases = new Set<string>();
  const states: string[] = [];
  for (let index = 0; index < sources.length; index++) {
    const entry: unknown = sources[index];
    if (!isRecord(entry) || !hasExactKeys(entry, ENTRY_KEYS)) {
      return false;
    }
    if (
      entry.sourceId !== `s${index + 1}` || !isRealtimeSnapshotProjection(entry.snapshot, true)
    ) {
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
  // A collapsed response (duplicate aliases, or over budget) is the one
  // legitimate `collection-failed` with no sources.
  if (sources.length === 0 && value.state === 'collection-failed') {
    return true;
  }
  return value.state === aggregateState(states);
}
