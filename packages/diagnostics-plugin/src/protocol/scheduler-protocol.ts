/**
 * Scheduler observation protocol (M98k): the exact, copy-once reading of
 * every registered scheduler source's snapshot, the aggregate response the
 * connector signs for `GET /v1/scheduler`, and the ONE validator both sides
 * of the wire run over it.
 *
 * A scheduler source is a multi-provider contribution any installed plugin
 * can register, so its snapshot is untrusted input: only plain objects
 * carrying own DATA properties are admitted (a getter, a custom prototype
 * or an extra key refuses the source), every field is read once and copied
 * individually, and a throwing proxy trap is caught. A source that fails any
 * check is reported as a fixed `collection-failed` snapshot carrying no
 * records and no error text.
 *
 * @module
 */

import type {
  DiagnosticsInspectorState,
  ISchedulerDiagnosticsSource,
  SchedulerDiagnosticsOperation,
  SchedulerDiagnosticsRecord,
  SchedulerDiagnosticsResponse,
  SchedulerDiagnosticsSnapshot,
} from '@setu-ts/common';

import {
  copyOwnData,
  copyOwnDataList,
  hasExactKeys,
  isDisplayAlias,
  isRecord,
} from './protocol.ts';

/**
 * The fixed source bound: a connector refuses to start with more scheduler
 * sources than this.
 *
 * @internal
 */
export const MAX_SCHEDULER_SOURCES = 16;

/** The fixed per-source record bound. */
const MAX_SCHEDULER_RECORDS = 64;

/** The fixed response budget, in UTF-8 bytes of the compact JSON. */
const MAX_SCHEDULER_RESPONSE_BYTES = 256 * 1024;

const OPERATIONS: ReadonlySet<string> = new Set<SchedulerDiagnosticsOperation>([
  'fire',
  'attempt',
]);

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

const SNAPSHOT_KEYS: readonly string[] = ['state', 'alias', 'coverage', 'records', 'dropped'];

const RECORD_KEYS: readonly string[] = [
  'alias',
  'operation',
  'count',
  'lastDurationMs',
  'ageMs',
  'started',
  'succeeded',
  'failed',
  'contended',
  'lockFailed',
  'retryAttempts',
  'lastLatenessMs',
];

/** The record fields that are non-negative safe-integer counters. */
const COUNTER_KEYS = [
  'count',
  'ageMs',
  'started',
  'succeeded',
  'failed',
  'contended',
  'lockFailed',
  'retryAttempts',
  'lastLatenessMs',
] as const;

const RESPONSE_KEYS: readonly string[] = ['version', 'instanceId', 'state', 'sources'];
const ENTRY_KEYS: readonly string[] = ['sourceId', 'snapshot'];

const ENCODER = new TextEncoder();

/** A non-negative safe integer. */
function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates one copied snapshot against the exact contract.
 *
 * @param value - The candidate snapshot
 * @returns `true` when the snapshot is well formed
 * @internal
 */
export function isSchedulerSnapshotProjection(
  value: unknown,
): value is SchedulerDiagnosticsSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    return false;
  }
  if (typeof value.state !== 'string' || !SOURCE_STATES.has(value.state)) {
    return false;
  }
  if (value.coverage !== 'owned-instance' || !isCounter(value.dropped)) {
    return false;
  }
  const disabled = value.state === 'disabled';
  // A disabled source has no alias; a collection-failed one may carry its
  // own approved alias or none (the connector's fixed failed snapshot); every
  // other state carries its approved alias.
  const aliasAllowedNull = disabled || value.state === 'collection-failed';
  if (value.alias === null ? !aliasAllowedNull : disabled || !isDisplayAlias(value.alias)) {
    return false;
  }
  const records = value.records;
  if (!Array.isArray(records) || records.length > MAX_SCHEDULER_RECORDS) {
    return false;
  }
  const empty = disabled || value.state === 'collection-failed' || value.state === 'no-data';
  if (empty && records.length !== 0) {
    return false;
  }
  if ((value.state === 'ready' || value.state === 'stale') && records.length === 0) {
    return false;
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (!isRecordProjection(record)) {
      return false;
    }
    const tuple = `${(record as { alias: string }).alias}|${
      (record as { operation: string }).operation
    }`;
    if (seen.has(tuple)) {
      return false;
    }
    seen.add(tuple);
  }
  return true;
}

/**
 * Validates one record: the exact keys, the fixed operation vocabulary, an
 * approved display alias (the JOB alias — a different namespace from the
 * snapshot's SOURCE alias, so the two are never compared), and non-negative
 * safe-integer counters.
 *
 * @param value - The candidate record
 * @returns `true` when the record is well formed
 */
function isRecordProjection(value: unknown): value is SchedulerDiagnosticsRecord {
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) {
    return false;
  }
  if (!isDisplayAlias(value.alias)) {
    return false;
  }
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation)) {
    return false;
  }
  if (value.lastDurationMs !== null && !isCounter(value.lastDurationMs)) {
    return false;
  }
  return COUNTER_KEYS.every((key) => isCounter(value[key]));
}

/**
 * The fixed snapshot a source answers when its read threw or failed
 * validation: no alias, no records, no error text.
 *
 * @returns A fresh value-free snapshot
 */
function failedSourceSnapshot(): Record<string, unknown> {
  return {
    state: 'collection-failed',
    alias: null,
    coverage: 'owned-instance',
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
function readSource(source: ISchedulerDiagnosticsSource): Record<string, unknown> {
  try {
    const raw: unknown = source.snapshot();
    const copy = copyOwnData(raw, SNAPSHOT_KEYS);
    if (copy === null) {
      return failedSourceSnapshot();
    }
    const records = copyOwnDataList(copy.records, MAX_SCHEDULER_RECORDS, RECORD_KEYS);
    if (records === null) {
      return failedSourceSnapshot();
    }
    copy.records = records;
    return isSchedulerSnapshotProjection(copy) ? copy : failedSourceSnapshot();
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
 * Builds the signed-ready `GET /v1/scheduler` response from every registered
 * source. Sources are read only here — after the request authenticated —
 * and each read is isolated. Duplicate non-null SOURCE aliases collapse the
 * whole response to a fixed `collection-failed` with no sources, and so does
 * a response whose compact JSON would exceed 256 KiB: a partial document is
 * never produced.
 *
 * @param instanceId - The session's bound instance UUID
 * @param sources - The sources resolved at bootstrap, in registration order
 * @returns The response record
 * @internal
 */
export function buildSchedulerResponse(
  instanceId: string,
  sources: readonly ISchedulerDiagnosticsSource[],
): Record<string, unknown> {
  const entries: Record<string, unknown>[] = [];
  const aliases = new Set<string>();
  const states: string[] = [];
  for (let index = 0; index < sources.length; index++) {
    const snapshot = readSource(sources[index] as ISchedulerDiagnosticsSource);
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
  if (ENCODER.encode(JSON.stringify(response)).byteLength > MAX_SCHEDULER_RESPONSE_BYTES) {
    return failedResponse(instanceId);
  }
  return response;
}

/**
 * The ONE validator both sides of the wire run over a scheduler response:
 * the exact keys, sequential `s<N>` source ids within the source bound,
 * every snapshot's exact contract, unique non-null SOURCE aliases, and an
 * aggregate state consistent with the per-source states.
 *
 * @param value - The candidate response
 * @returns `true` when the response is well formed
 * @internal
 */
export function isSchedulerResponseProjection(
  value: unknown,
): value is SchedulerDiagnosticsResponse {
  if (!isRecord(value) || !hasExactKeys(value, RESPONSE_KEYS)) {
    return false;
  }
  if (value.version !== 1 || typeof value.instanceId !== 'string' || value.instanceId === '') {
    return false;
  }
  const sources = value.sources;
  if (!Array.isArray(sources) || sources.length > MAX_SCHEDULER_SOURCES) {
    return false;
  }
  const aliases = new Set<string>();
  const states: string[] = [];
  for (let index = 0; index < sources.length; index++) {
    const entry: unknown = sources[index];
    if (!isRecord(entry) || !hasExactKeys(entry, ENTRY_KEYS)) {
      return false;
    }
    if (entry.sourceId !== `s${index + 1}` || !isSchedulerSnapshotProjection(entry.snapshot)) {
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
