/**
 * Protocol v1: the exact operations, canonical target grammar, DTO
 * projection, and fixed error bodies.
 *
 * The projection functions copy field-by-field against M98a's exact
 * allowlist — never a spread of a provider result — so an unexpected field
 * on an internal DTO cannot reach the wire, and the bounded body ceiling is
 * checked on the SERIALIZED bytes.
 *
 * @module
 */

import type {
  DiagnosticsBatch,
  DiagnosticsEvent,
  DiagnosticsSnapshot,
  HealthDiagnosticsObservation,
  HealthDiagnosticsSnapshot,
} from '@setu-ts/common';

/**
 * The signed protocol error codes, and the HTTP status each answers with.
 * Fixed vocabulary: no reflected input, no error causes, no stacks.
 *
 * @internal
 */
export const PROTOCOL_ERRORS = {
  'invalid-request': 400,
  unauthorized: 401,
  expired: 401,
  'unsupported-version': 400,
  unavailable: 503,
  'rate-limited': 429,
} as const;

/**
 * A protocol error code.
 *
 * @internal
 */
export type ProtocolErrorCode = keyof typeof PROTOCOL_ERRORS;

/**
 * The fixed response headers every protocol response — signed or refusal —
 * carries.
 *
 * @internal
 */
export const PROTOCOL_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/**
 * The protocol operations' canonical targets. The events and queues targets
 * are the only ones carrying a query, and only in the canonical
 * `?after=<N>&limit=<N>` form — exactly this order, both parameters, no
 * others.
 *
 * @internal
 */
export const STATUS_TARGET = '/v1/status';
export const SNAPSHOT_TARGET = '/v1/snapshot';
export const HEALTH_TARGET = '/v1/health';
const EVENTS_PATH = '/v1/events';
/**
 * The queue observations path (M98f); its target carries the same canonical
 * `?after=<N>&limit=<N>` query as the events target.
 *
 * @internal
 */
export const QUEUES_PATH = '/v1/queues';
/**
 * The trace observations path (M98g); its target carries the same canonical
 * `?after=<N>&limit=<N>` query as the events and queues targets.
 *
 * @internal
 */
export const TRACES_PATH = '/v1/traces';

/**
 * The maximum events per read — the same fixed 128 the kernel's reader
 * accepts.
 *
 * @internal
 */
const CONNECTOR_MAX_EVENT_LIMIT = 128;

/**
 * The canonical query grammar for the events target: digits only, this
 * exact order, no other field. Captured groups are the raw digit strings.
 *
 * @internal
 */
const EVENTS_QUERY = /^after=([0-9]+)&limit=([0-9]+)$/;

/**
 * One parsed, canonical protocol target.
 *
 * @internal
 */
export interface ParsedTarget {
  readonly op: 'status' | 'snapshot' | 'events' | 'health' | 'queues' | 'traces';
  /** The exact canonical target string, byte-identical to the request's. */
  readonly canonicalTarget: string;
  /** The parsed `after` cursor (events and queues); `0` for the other ops. */
  readonly after: number;
  /** The parsed limit (events and queues); `0` for the other ops. */
  readonly limit: number;
}

/**
 * Parses and canonically validates a request target. Anything that is not
 * one of the three operations in canonical form — an unknown operation, an
 * extra path segment, a percent-encoded alias, a reordered or duplicated or
 * unknown query field, a non-canonical number (leading zeros), an
 * out-of-range `after` or `limit` — refuses.
 *
 * @param path - The request path (from the framework request)
 * @param search - The raw query string WITHOUT the leading `?` (empty when
 * the request carried no query)
 * @returns The parsed target, or `null` for any non-canonical form
 * @internal
 */
export function parseTarget(path: string, search: string): ParsedTarget | null {
  if (path === STATUS_TARGET && search === '') {
    return { op: 'status', canonicalTarget: STATUS_TARGET, after: 0, limit: 0 };
  }
  if (path === SNAPSHOT_TARGET && search === '') {
    return { op: 'snapshot', canonicalTarget: SNAPSHOT_TARGET, after: 0, limit: 0 };
  }
  if (path === HEALTH_TARGET && search === '') {
    return { op: 'health', canonicalTarget: HEALTH_TARGET, after: 0, limit: 0 };
  }
  if (path === EVENTS_PATH) {
    return parsePagedTarget('events', path, search);
  }
  if (path === QUEUES_PATH) {
    return parsePagedTarget('queues', path, search);
  }
  if (path === TRACES_PATH) {
    return parsePagedTarget('traces', path, search);
  }
  return null;
}

/**
 * Parses the canonical `after=<N>&limit=<N>` query of a paged target — the
 * ONE grammar the events and queues operations share, so the two cannot drift
 * about what a canonical cursor is.
 *
 * @param op - The paged operation
 * @param path - The exact operation path
 * @param search - The raw query string without the leading `?`
 * @returns The parsed target, or `null` for any non-canonical form
 */
function parsePagedTarget(
  op: 'events' | 'queues' | 'traces',
  path: string,
  search: string,
): ParsedTarget | null {
  const match = EVENTS_QUERY.exec(search);
  if (match === null) {
    return null;
  }
  const after = parseCanonical(match[1]);
  const limit = parseCanonical(match[2]);
  if (after === null || limit === null) {
    return null;
  }
  if (after > Number.MAX_SAFE_INTEGER || limit < 1 || limit > CONNECTOR_MAX_EVENT_LIMIT) {
    return null;
  }
  return { op, canonicalTarget: `${path}?${search}`, after, limit };
}

/**
 * Parses a canonical non-negative decimal: digits only, no leading zero
 * unless the value is exactly `0`.
 *
 * @param digits - The raw digit string
 * @returns The value, or `null` for a non-canonical form
 */
function parseCanonical(digits: string): number | null {
  if (digits.length > 1 && digits.charCodeAt(0) === 0x30) {
    return null;
  }
  if (digits.length > 16) {
    return null;
  }
  return Number.parseInt(digits, 10);
}

/**
 * Validates a value is a plain record (JSON object).
 *
 * @param value - The value to check
 * @returns `true` when the value is a non-null, non-array object
 * @internal
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copies an optional field only when present — `exactOptionalPropertyTypes`
 * semantics for a plain-JSON projection.
 *
 * @param target - The projection under construction
 * @param key - The projected field name
 * @param value - The source value
 */
function copyOptional(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * Re-projects a snapshot against the exact M98a field allowlist. The body
 * is M98a's compact final snapshot JSON — not an envelope — so the
 * projection must produce exactly the DTO's fields and no others.
 *
 * @param snapshot - The source snapshot from `IApplication.diagnostics`
 * @returns The projected, serialization-ready record
 * @internal
 */
export function projectSnapshot(snapshot: DiagnosticsSnapshot): Record<string, unknown> {
  return {
    version: snapshot.version,
    instanceId: snapshot.instanceId,
    state: snapshot.state,
    failureCode: snapshot.failureCode,
    nodes: snapshot.nodes.map((node) => {
      const projected: Record<string, unknown> = {
        id: node.id,
        kind: node.kind,
      };
      copyOptional(projected, 'label', node.label);
      copyOptional(projected, 'version', node.version);
      copyOptional(projected, 'method', node.method);
      copyOptional(projected, 'priority', node.priority);
      copyOptional(projected, 'position', node.position);
      copyOptional(projected, 'registered', node.registered);
      return projected;
    }),
    edges: snapshot.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
    })),
    truncated: snapshot.truncated,
    droppedEvents: snapshot.droppedEvents,
  };
}

/**
 * Re-projects one event against the exact M98a field allowlist.
 *
 * @param event - The source event
 * @returns The projected record
 * @internal
 */
export function projectEvent(event: DiagnosticsEvent): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    sequence: event.sequence,
    operationId: event.operationId,
    parentOperationId: event.parentOperationId,
    kind: event.kind,
    stage: event.stage,
    nodeId: event.nodeId,
    outcome: event.outcome,
    atMs: event.atMs,
    durationMs: event.durationMs,
  };
  copyOptional(projected, 'statusCode', event.statusCode);
  copyOptional(projected, 'traceId', event.traceId);
  copyOptional(projected, 'spanId', event.spanId);
  return projected;
}

/**
 * Re-projects a batch against the exact M98a field allowlist.
 *
 * @param batch - The source batch
 * @returns The projected record
 * @internal
 */
export function projectBatch(batch: DiagnosticsBatch): Record<string, unknown> {
  return {
    version: batch.version,
    instanceId: batch.instanceId,
    events: batch.events.map(projectEvent),
    next: batch.next,
    lost: batch.lost,
    closed: batch.closed,
  };
}

/**
 * The signed status body: protocol version, the bound instance UUID, the
 * session's remaining lifetime, and the fixed inspector support manifest.
 *
 * @param instanceId - The application's non-null instance UUID
 * @param expiresInMs - Remaining session lifetime in milliseconds
 * @param inspectors - The fixed inspector support manifest
 * @returns The status record
 * @internal
 */
export function statusBody(
  instanceId: string,
  expiresInMs: number,
  inspectors: InspectorsManifest,
): Record<string, unknown> {
  return { version: 1, instanceId, expiresInMs, inspectors };
}

/**
 * The legacy M98b status body: exactly the three fields, no inspector
 * manifest. Used by the compatibility matrix to simulate an old server; the
 * new client reads it as "all inspectors false".
 *
 * @param instanceId - The application's non-null instance UUID
 * @param expiresInMs - Remaining session lifetime in milliseconds
 * @returns The legacy status record
 * @internal
 */
export function legacyStatusBody(
  instanceId: string,
  expiresInMs: number,
): Record<string, unknown> {
  return { version: 1, instanceId, expiresInMs };
}

/**
 * The fixed inspector support manifest keys. The authenticated status body
 * carries exactly these eleven boolean keys and no others; a key means the
 * connector IMPLEMENTS and validates that operation, independent of whether
 * the application registered its owning source. Inspectors beyond these
 * eleven require a new protocol version.
 *
 * @internal
 */
export const INSPECTOR_KEYS = [
  'health',
  'configuration',
  'queues',
  'traces',
  'authorization',
  'cache',
  'events',
  'scheduler',
  'realtime',
  'storage',
  'outboundHttp',
] as const;

/**
 * The fixed inspector support manifest: one boolean per inspector key.
 *
 * @internal
 */
export type InspectorsManifest = Readonly<Record<(typeof INSPECTOR_KEYS)[number], boolean>>;

/**
 * The inspector manifest this connector serves: `health` (M98d) and `queues`
 * (M98f) are implemented; the rest are reserved and false until their own
 * connector operation ships.
 *
 * @returns The fixed manifest
 * @internal
 */
export function currentInspectorsManifest(): InspectorsManifest {
  return {
    health: true,
    configuration: false,
    queues: true,
    traces: true,
    authorization: false,
    cache: false,
    events: false,
    scheduler: false,
    realtime: false,
    storage: false,
    outboundHttp: false,
  };
}

/**
 * The fixed error body shape.
 *
 * @param code - One fixed protocol error code
 * @returns The error record
 * @internal
 */
export function errorBody(code: ProtocolErrorCode): Record<string, unknown> {
  return { version: 1, error: code };
}

/**
 * The status body's exact key set — the client checks the parsed body
 * against this and against the authenticated `X-Setu-Instance` header.
 *
 * @internal
 */
/**
 * The base status body keys — always present, in both the legacy and the
 * new body.
 *
 * @internal
 */
export const STATUS_BASE_KEYS: readonly string[] = ['version', 'instanceId', 'expiresInMs'];

/**
 * A well-formed parsed status body plus its resolved inspector manifest.
 *
 * @internal
 */
export interface ParsedStatusBody {
  readonly instanceId: string;
  readonly expiresInMs: number;
  readonly inspectors: InspectorsManifest;
}

/**
 * Builds the all-false inspector manifest — the resolution of the legacy
 * M98b three-field status body, which advertised no inspectors.
 *
 * @returns The all-false manifest
 * @internal
 */
export function allFalseInspectors(): InspectorsManifest {
  return {
    health: false,
    configuration: false,
    queues: false,
    traces: false,
    authorization: false,
    cache: false,
    events: false,
    scheduler: false,
    realtime: false,
    storage: false,
    outboundHttp: false,
  };
}

/**
 * Validates the inspector manifest: exactly the eleven fixed keys, all
 * boolean. Unknown, missing, or extra keys and any non-boolean fail — the
 * manifest is a fixed, authenticated contract, not an extensible record.
 *
 * @param value - The parsed `inspectors` value
 * @returns `true` when the value is a well-formed manifest
 * @internal
 */
export function isInspectorsManifest(value: unknown): value is InspectorsManifest {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== INSPECTOR_KEYS.length || INSPECTOR_KEYS.some((k) => !(k in value))) {
    return false;
  }
  return INSPECTOR_KEYS.every((k) => typeof value[k] === 'boolean');
}

/**
 * Parses and validates a status body, accepting BOTH the legacy M98b
 * three-field body and the new four-field body carrying the inspector
 * manifest.
 *
 * The legacy body — exactly `version`, `instanceId`, `expiresInMs` —
 * resolves to the all-false manifest, so a new client pairing against an old
 * server sees every inspector as unsupported and never probes an unknown
 * route. The new body — those three plus `inspectors` — must carry a
 * well-formed manifest; any unknown, missing, or extra manifest key, or any
 * non-boolean, fails. Any OTHER key count or shape fails outright.
 *
 * @param value - The parsed JSON value
 * @returns The parsed status body, or `null` for any non-conforming shape
 * @internal
 */
export function parseStatusBody(value: unknown): ParsedStatusBody | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const hasInspectors = 'inspectors' in value;
  const expectedCount = STATUS_BASE_KEYS.length + (hasInspectors ? 1 : 0);
  if (keys.length !== expectedCount || STATUS_BASE_KEYS.some((k) => !(k in value))) {
    return null;
  }
  if (
    value.version !== 1 ||
    typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0 ||
    typeof value.expiresInMs !== 'number' ||
    !Number.isFinite(value.expiresInMs) ||
    value.expiresInMs < 0
  ) {
    return null;
  }
  const inspectors = hasInspectors
    ? isInspectorsManifest(value.inspectors) ? value.inspectors : null
    : allFalseInspectors();
  if (inspectors === null) {
    return null;
  }
  return { instanceId: value.instanceId, expiresInMs: value.expiresInMs, inspectors };
}

/**
 * Reports whether a parsed value is a well-formed M98a snapshot projection:
 * version `1` and every projected field present with the right primitive
 * type. Used by the native client before it hands data to a consumer.
 *
 * @param value - The parsed JSON value
 * @returns `true` when the value is a well-formed snapshot
 * @internal
 */
export function isSnapshotProjection(value: unknown): value is DiagnosticsSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return value.version === 1 &&
    (typeof value.instanceId === 'string' || value.instanceId === null) &&
    typeof value.state === 'string' &&
    (value.failureCode === null || typeof value.failureCode === 'string') &&
    Array.isArray(value.nodes) &&
    value.nodes.every((node) =>
      isRecord(node) && typeof node.id === 'string' &&
      typeof node.kind === 'string'
    ) &&
    Array.isArray(value.edges) &&
    value.edges.every((edge) =>
      isRecord(edge) && typeof edge.from === 'string' &&
      typeof edge.to === 'string' && typeof edge.kind === 'string'
    ) &&
    typeof value.truncated === 'boolean' &&
    typeof value.droppedEvents === 'number';
}

/**
 * Reports whether a parsed value is a well-formed M98a batch projection.
 *
 * @param value - The parsed JSON value
 * @returns `true` when the value is a well-formed batch
 * @internal
 */
export function isBatchProjection(value: unknown): value is DiagnosticsBatch {
  if (!isRecord(value)) {
    return false;
  }
  return value.version === 1 &&
    (typeof value.instanceId === 'string' || value.instanceId === null) &&
    Array.isArray(value.events) &&
    value.events.every((event) =>
      isRecord(event) && typeof event.sequence === 'number' &&
      typeof event.operationId === 'string' && typeof event.stage === 'string'
    ) &&
    typeof value.next === 'number' &&
    typeof value.lost === 'number' &&
    typeof value.closed === 'boolean';
}

/**
 * The fixed inspector-state vocabulary the health snapshot projects onto.
 *
 * @internal
 */
const INSPECTOR_STATES: ReadonlySet<string> = new Set([
  'unsupported',
  'disabled',
  'no-data',
  'ready',
  'stale',
  'collection-failed',
]);

/**
 * The fixed observation-state vocabulary the health snapshot projects onto.
 *
 * @internal
 */
const OBSERVATION_STATES: ReadonlySet<string> = new Set([
  'reported',
  'timed-out',
  'failed',
  'never-observed',
]);

/**
 * The fixed health status vocabulary the health snapshot projects onto.
 *
 * @internal
 */
const HEALTH_STATUSES: ReadonlySet<string> = new Set(['up', 'degraded', 'down']);

/**
 * The fixed origin vocabulary the health snapshot projects onto.
 *
 * @internal
 */
const ORIGINS: ReadonlySet<string> = new Set(['application', 'scheduled']);

/**
 * Re-projects one health observation against the exact M98d field allowlist.
 * Copies field-by-field — never a spread of a provider result — so an
 * unexpected field on an internal DTO cannot reach the wire.
 *
 * @param observation - The source observation
 * @returns The projected record
 * @internal
 */
export function projectHealthObservation(
  observation: HealthDiagnosticsObservation,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    indicatorAlias: observation.indicatorAlias,
    state: observation.state,
    latencyMs: observation.latencyMs,
    ageMs: observation.ageMs,
    origin: observation.origin,
  };
  copyOptional(projected, 'status', observation.status);
  return projected;
}

/**
 * Re-projects a health snapshot against the exact M98d field allowlist. The
 * body is the compact final health-snapshot JSON — not an envelope — so the
 * projection produces exactly the DTO's fields and no others.
 *
 * @param snapshot - The source health snapshot
 * @returns The projected, serialization-ready record
 * @internal
 */
export function projectHealthSnapshot(
  snapshot: HealthDiagnosticsSnapshot,
): Record<string, unknown> {
  return {
    version: snapshot.version,
    instanceId: snapshot.instanceId,
    state: snapshot.state,
    observations: snapshot.observations.map(projectHealthObservation),
    truncated: snapshot.truncated,
    droppedObservations: snapshot.droppedObservations,
  };
}

/** The exact snapshot keys a health projection carries. */
const HEALTH_SNAPSHOT_KEYS: readonly string[] = [
  'version',
  'instanceId',
  'state',
  'observations',
  'truncated',
  'droppedObservations',
];

/** The observation keys always present; `status` is added exactly when `reported`. */
const HEALTH_OBSERVATION_KEYS: readonly string[] = [
  'indicatorAlias',
  'state',
  'latencyMs',
  'ageMs',
  'origin',
];

/** The fixed upper bound on approved aliases, and so on projected observations. */
const MAX_HEALTH_OBSERVATIONS = 64;

/** The fixed upper bound on an alias's UTF-8 byte length. */
const MAX_ALIAS_BYTES = 64;

const ALIAS_ENCODER = new TextEncoder();

/**
 * Reports whether a record has exactly the given own keys.
 *
 * @internal
 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

/**
 * Reports whether a value is an approved-alias SHAPE: a string of 1–64
 * UTF-8 bytes. (Control characters are refused where the alias is approved;
 * the wire bound is the byte length.)
 *
 * @param value - The candidate alias
 * @returns `true` for a well-shaped alias
 * @internal
 */
export function isAliasShape(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const bytes = ALIAS_ENCODER.encode(value).length;
  return bytes >= 1 && bytes <= MAX_ALIAS_BYTES;
}

/**
 * Reports whether a string carries a C0/C1 control code point. Shared by
 * every display-alias check on the wire — a control character in a displayed
 * alias could forge a consumer's output.
 *
 * @param value - The candidate string
 * @returns `true` when a control code point is present
 * @internal
 */
export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** A finite, non-negative millisecond measurement, or `null` where allowed. */
function isMeasurement(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

/** Validates one projected observation against the exact M98d DTO. */
function isHealthObservationProjection(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const reported = value.state === 'reported';
  const keys = reported ? [...HEALTH_OBSERVATION_KEYS, 'status'] : HEALTH_OBSERVATION_KEYS;
  if (!hasExactKeys(value, keys)) {
    return false;
  }
  return isAliasShape(value.indicatorAlias) &&
    typeof value.state === 'string' && OBSERVATION_STATES.has(value.state) &&
    (!reported || (typeof value.status === 'string' && HEALTH_STATUSES.has(value.status))) &&
    isMeasurement(value.latencyMs) &&
    isMeasurement(value.ageMs) &&
    typeof value.origin === 'string' && ORIGINS.has(value.origin);
}

/**
 * Reports whether a value is a well-formed M98d health-snapshot projection:
 * EXACTLY the six snapshot keys, version `1`, a non-empty instance string, a
 * fixed inspector state, at most 64 observations, a non-negative safe-integer
 * drop count, and every observation carrying exactly its allowed keys —
 * `status` present if and only if the state is `reported`, every enum from
 * its fixed vocabulary, every measurement finite and non-negative or `null`,
 * every alias 1–64 UTF-8 bytes.
 *
 * ONE validator for both sides of the wire: the connector runs it over its
 * own field-by-field projection before signing (a source that violates the
 * DTO is answered `collection-failed`, so nothing unvalidated is signed),
 * and the native client runs it again before handing data to a consumer.
 *
 * @param value - The parsed JSON value, or a fresh projection
 * @returns `true` when the value is a well-formed health snapshot
 * @internal
 */
export function isHealthSnapshotProjection(value: unknown): value is HealthDiagnosticsSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, HEALTH_SNAPSHOT_KEYS)) {
    return false;
  }
  return value.version === 1 &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    typeof value.state === 'string' &&
    INSPECTOR_STATES.has(value.state) &&
    Array.isArray(value.observations) &&
    value.observations.length <= MAX_HEALTH_OBSERVATIONS &&
    typeof value.truncated === 'boolean' &&
    typeof value.droppedObservations === 'number' &&
    Number.isSafeInteger(value.droppedObservations) &&
    value.droppedObservations >= 0 &&
    value.observations.every(isHealthObservationProjection);
}
