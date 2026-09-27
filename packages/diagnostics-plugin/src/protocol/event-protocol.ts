/**
 * Event observation protocol (M98j): the exact validation of an event
 * source's snapshot before the connector signs it, the field-by-field
 * projection of the connector's per-source response, and the ONE validator
 * both sides of the wire run over it.
 *
 * An event source is a registered capability, so its snapshot is untrusted
 * input to the connector: every field is read once, checked against its
 * fixed vocabulary or bound, and copied — never spread — so an unexpected
 * field, a throwing getter, an oversized alias or a control character cannot
 * reach the signed frame.
 *
 * @module
 */

import type {
  DiagnosticsInspectorState,
  EventDiagnosticsRecord,
  EventDiagnosticsResponse,
  EventDiagnosticsSnapshot,
  EventDiagnosticsState,
  EventObservationOperation,
} from '@setu-ts/common';

import {
  copyOwnData,
  copyOwnDataList,
  hasExactKeys,
  isDisplayAlias,
  isRecord,
} from './protocol.ts';

/** The per-source record-slot budget — the same fixed 64 the collector enforces. */
const MAX_EVENT_RECORDS = 64;

/**
 * The connector's fixed 16-source bound; more registered sources refuse
 * startup (the M98i cache precedent) rather than being silently dropped.
 *
 * @internal
 */
export const MAX_EVENT_SOURCES = 16;

/**
 * The fixed response byte budget; an over-budget body collapses to the
 * fixed `collection-failed` response rather than a refusal.
 *
 * @internal
 */
export const MAX_EVENT_RESPONSE_BYTES = 256 * 1024;

const SOURCE_STATES: ReadonlySet<string> = new Set<EventDiagnosticsState>([
  'disabled',
  'no-data',
  'ready',
  'stale',
  'collection-failed',
]);
const OPERATIONS: ReadonlySet<string> = new Set<EventObservationOperation>([
  'publish',
  'handler',
]);
const INSPECTOR_STATES: ReadonlySet<string> = new Set<DiagnosticsInspectorState>([
  'unsupported',
  'disabled',
  'no-data',
  'ready',
  'stale',
  'collection-failed',
]);

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

const SNAPSHOT_KEYS: readonly string[] = ['state', 'alias', 'coverage', 'records', 'dropped'];
const RECORD_KEYS: readonly string[] = [
  'alias',
  'operation',
  'count',
  'started',
  'succeeded',
  'failed',
  'noSubscribers',
  'lastDurationMs',
  'ageMs',
];

/**
 * Validates one record already copied by {@linkcode copyOwnDataList} (so
 * every field is a plain own DATA value read exactly once, and no getter
 * was ever invoked).
 */
function readRecord(value: Record<string, unknown>): EventDiagnosticsRecord | null {
  const {
    alias,
    operation,
    count,
    started,
    succeeded,
    failed,
    noSubscribers,
    lastDurationMs,
    ageMs,
  } = value;
  if (
    !isDisplayAlias(alias) || !isOneOf(operation, OPERATIONS) ||
    !isCount(count) || !isCount(started) || !isCount(succeeded) || !isCount(failed) ||
    !isCount(noSubscribers) ||
    (lastDurationMs !== null && !isMs(lastDurationMs)) ||
    !isMs(ageMs)
  ) {
    return null;
  }
  return {
    alias,
    operation: operation as EventObservationOperation,
    count,
    started,
    succeeded,
    failed,
    noSubscribers,
    lastDurationMs: lastDurationMs as number | null,
    ageMs,
  };
}

/**
 * Validates an untrusted event source snapshot against the exact M98j DTO
 * and returns a field-by-field copy.
 *
 * The snapshot and every record are copied through the shared own-data
 * reader FIRST: only a plain object (prototype `Object.prototype` or `null`)
 * of own DATA properties with exactly the contract's keys is admitted, each
 * property is read once through its descriptor, and a getter is never
 * invoked — the M98i cache precedent. Then refused: a value outside its
 * fixed vocabulary or bound; an alias outside the display shape (including
 * the required non-null alias of an enabled source); a non-array or
 * oversized `records`; a `disabled` or `collection-failed` snapshot carrying
 * any record; and any throw while reading (a `Proxy` trap).
 *
 * @param value - The snapshot the source returned
 * @returns The validated copy, or `null` for any violation
 * @internal
 */
export function readEventSourceSnapshot(
  value: unknown,
): EventDiagnosticsSnapshot | null {
  try {
    const copy = copyOwnData(value, SNAPSHOT_KEYS);
    if (copy === null) {
      return null;
    }
    const { state, alias, coverage, dropped } = copy;
    if (!isOneOf(state, SOURCE_STATES)) {
      return null;
    }
    // An enabled source always knows its approved alias; `disabled` (the
    // inert source) carries `null`. A `collection-failed` read cannot vouch
    // for the alias, so both `null` and a display alias are admitted there.
    if (state === 'disabled') {
      if (alias !== null) {
        return null;
      }
    } else if (state === 'collection-failed') {
      if (alias !== null && !isDisplayAlias(alias)) {
        return null;
      }
    } else if (!isDisplayAlias(alias)) {
      return null;
    }
    if (coverage !== 'owned-instance' || !isCount(dropped)) {
      return null;
    }
    const rawRecords = copyOwnDataList(copy.records, MAX_EVENT_RECORDS, RECORD_KEYS);
    if (rawRecords === null) {
      return null;
    }
    // `disabled` and `collection-failed` observe by definition (or latched a
    // fault): neither retains a record.
    if ((state === 'disabled' || state === 'collection-failed') && rawRecords.length > 0) {
      return null;
    }
    const records: EventDiagnosticsRecord[] = [];
    for (const raw of rawRecords) {
      const record = readRecord(raw);
      if (record === null) {
        return null;
      }
      records.push(record);
    }
    return {
      state: state as EventDiagnosticsState,
      alias: alias as string | null,
      coverage: 'owned-instance',
      records,
      dropped,
    };
  } catch {
    return null;
  }
}

/**
 * A value-free `collection-failed` source snapshot the connector builds
 * itself when a registered source threw or answered an invalid shape. It
 * carries the fixed alias-free shape: no error text, cause, or stack.
 * @internal
 */
export function collectionFailedEventSnapshot(): EventDiagnosticsSnapshot {
  return {
    state: 'collection-failed',
    alias: null,
    coverage: 'owned-instance',
    records: [],
    dropped: 0,
  };
}

/**
 * Projects a validated per-source entry into the serialization-ready record
 * — field by field, never a spread.
 *
 * @param sourceId - The connector-assigned `s<N>` identifier
 * @param snapshot - The validated snapshot
 * @returns The projected entry
 * @internal
 */
export function projectEventSource(
  sourceId: string,
  snapshot: EventDiagnosticsSnapshot,
): Record<string, unknown> {
  return {
    sourceId,
    snapshot: {
      state: snapshot.state,
      alias: snapshot.alias,
      coverage: snapshot.coverage,
      records: snapshot.records.map((record) => ({
        alias: record.alias,
        operation: record.operation,
        count: record.count,
        started: record.started,
        succeeded: record.succeeded,
        failed: record.failed,
        noSubscribers: record.noSubscribers,
        lastDurationMs: record.lastDurationMs,
        ageMs: record.ageMs,
      })),
      dropped: snapshot.dropped,
    },
  };
}

const RESPONSE_KEYS: readonly string[] = [
  'version',
  'instanceId',
  'state',
  'sources',
];
const SOURCE_ENTRY_KEYS: readonly string[] = ['sourceId', 'snapshot'];
/**
 * Validates one projected per-source entry against the exact M98j DTO. The
 * session-local id is positional: entry `index` must be `s<index + 1>`
 * (the M98i cache precedent).
 */
function isSourceEntryProjection(value: unknown, index: number): boolean {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_ENTRY_KEYS)) {
    return false;
  }
  if (value.sourceId !== `s${index + 1}`) {
    return false;
  }
  const snapshot = value.snapshot;
  if (
    !isRecord(snapshot) || !hasExactKeys(snapshot, SNAPSHOT_KEYS) ||
    !isOneOf(snapshot.state, SOURCE_STATES)
  ) {
    return false;
  }
  // Mirror the source validator's alias rule exactly: required display alias
  // when enabled, `null` when disabled, either when collection-failed.
  const aliasOk = snapshot.state === 'disabled'
    ? snapshot.alias === null
    : snapshot.state === 'collection-failed'
    ? snapshot.alias === null || isDisplayAlias(snapshot.alias)
    : isDisplayAlias(snapshot.alias);
  if (
    !aliasOk ||
    snapshot.coverage !== 'owned-instance' ||
    !Array.isArray(snapshot.records) || snapshot.records.length > MAX_EVENT_RECORDS ||
    !isCount(snapshot.dropped)
  ) {
    return false;
  }
  if ((snapshot.state === 'disabled' || snapshot.state === 'collection-failed')) {
    if ((snapshot.records as unknown[]).length > 0) {
      return false;
    }
  }
  return (snapshot.records as unknown[]).every((record) => {
    if (!isRecord(record) || !hasExactKeys(record, RECORD_KEYS)) {
      return false;
    }
    return isDisplayAlias(record.alias) &&
      isOneOf(record.operation, OPERATIONS) &&
      isCount(record.count) && isCount(record.started) && isCount(record.succeeded) &&
      isCount(record.failed) && isCount(record.noSubscribers) &&
      (record.lastDurationMs === null || isMs(record.lastDurationMs)) &&
      isMs(record.ageMs);
  });
}

/**
 * Reports whether a value is a well-formed M98j event response projection:
 * EXACTLY the four response keys, version `1`, a non-empty instance string,
 * a fixed inspector state, and at most 16 per-source entries each carrying a
 * positional `s<N>` id and a well-formed snapshot.
 *
 * ONE validator for both sides of the wire: the connector runs it over its
 * own field-by-field projection before signing (nothing unvalidated is
 * signed), and the native client runs it again before handing data to a
 * consumer.
 *
 * @param value - The parsed JSON value, or a fresh projection
 * @returns `true` when the value is a well-formed event response
 * @internal
 */
export function isEventResponseProjection(value: unknown): value is EventDiagnosticsResponse {
  if (!isRecord(value) || !hasExactKeys(value, RESPONSE_KEYS)) {
    return false;
  }
  if (
    value.version !== 1 ||
    typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0 ||
    !isOneOf(value.state, INSPECTOR_STATES) ||
    !Array.isArray(value.sources) ||
    value.sources.length > MAX_EVENT_SOURCES
  ) {
    return false;
  }
  return (value.sources as unknown[]).every((entry, index) =>
    isSourceEntryProjection(entry, index)
  );
}
