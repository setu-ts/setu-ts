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
  ConfigDiagnosticsSnapshot,
  ConfigProvenanceEntry,
  DiagnosticsBatch,
  DiagnosticsEdge,
  DiagnosticsEdgeKind,
  DiagnosticsEvent,
  DiagnosticsEventKind,
  DiagnosticsEventOutcome,
  DiagnosticsEventStage,
  DiagnosticsFailureCode,
  DiagnosticsNode,
  DiagnosticsSnapshot,
  DiagnosticsSnapshotState,
  HealthDiagnosticsObservation,
  HealthDiagnosticsSnapshot,
  HttpMethod,
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
export const CONFIG_TARGET = '/v1/config';
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
  readonly op: 'status' | 'snapshot' | 'events' | 'health' | 'config' | 'queues' | 'traces';
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
  if (path === CONFIG_TARGET && search === '') {
    return { op: 'config', canonicalTarget: CONFIG_TARGET, after: 0, limit: 0 };
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
 * The inspector manifest this connector serves: `health` (M98d),
 * `configuration` (M98e) and `queues` (M98f) are implemented; the rest are
 * reserved and false until their own connector operation ships.
 *
 * @returns The fixed manifest
 * @internal
 */
export function currentInspectorsManifest(): InspectorsManifest {
  return {
    health: true,
    configuration: true,
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

/** The exact snapshot keys a core M98a snapshot carries. */
const SNAPSHOT_KEYS: readonly string[] = [
  'version',
  'instanceId',
  'state',
  'failureCode',
  'nodes',
  'edges',
  'truncated',
  'droppedEvents',
];

/** The exact batch keys a core M98a event batch carries. */
const BATCH_KEYS: readonly string[] = ['version', 'instanceId', 'events', 'next', 'lost', 'closed'];

/** The event keys always present; the three optional ones follow. */
const EVENT_REQUIRED_KEYS: readonly string[] = [
  'sequence',
  'operationId',
  'parentOperationId',
  'kind',
  'stage',
  'nodeId',
  'outcome',
  'atMs',
  'durationMs',
];
const EVENT_OPTIONAL_KEYS: readonly string[] = ['statusCode', 'traceId', 'spanId'];

/**
 * The optional keys each node kind may carry beyond `id` and `kind` — the
 * kernel emits a field only when it is meaningful for the kind, so a field
 * outside its kind's set is a contract violation, not extra information.
 */
const NODE_OPTIONAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  plugin: ['label', 'version'],
  capability: ['label', 'registered'],
  route: ['label', 'method'],
  middleware: ['label', 'priority', 'position'],
};

/** The opaque node-id prefix each node kind is minted with (`p1`, `c1`, `r1`, `m1`). */
const NODE_ID_PREFIX: Readonly<Record<string, string>> = {
  plugin: 'p',
  capability: 'c',
  route: 'r',
  middleware: 'm',
};

/**
 * Builds a vocabulary set from a record keyed by EVERY member of a `common`
 * union, so adding a member to the union without adding it here is a compile
 * error — not a client that refuses every body carrying the new value.
 *
 * @param members - One `true` entry per union member
 * @returns The vocabulary as a set
 */
function vocabulary<T extends string>(members: Readonly<Record<T, true>>): ReadonlySet<string> {
  return new Set(Object.keys(members));
}

/** The fixed snapshot-state vocabulary (`DiagnosticsSnapshotState`). */
const SNAPSHOT_STATES: ReadonlySet<string> = vocabulary<DiagnosticsSnapshotState>({
  'created': true,
  'starting': true,
  'running': true,
  'failed': true,
  'stopping': true,
  'closed': true,
});

/** The fixed failure-code vocabulary (`DiagnosticsFailureCode`). */
const FAILURE_CODES: ReadonlySet<string> = vocabulary<DiagnosticsFailureCode>({
  'startup-failed': true,
  'shutdown-failed': true,
});

/** The fixed edge-kind vocabulary (`DiagnosticsEdgeKind`). */
const EDGE_KINDS: ReadonlySet<string> = vocabulary<DiagnosticsEdgeKind>({
  'provides': true,
  'requires': true,
  'optional': true,
  'consumes': true,
  'owns': true,
});

/** The fixed event-kind vocabulary (`DiagnosticsEventKind`). */
const EVENT_KINDS: ReadonlySet<string> = vocabulary<DiagnosticsEventKind>({
  'lifecycle': true,
  'request': true,
  'middleware': true,
  'handler': true,
});

/** The fixed event-stage vocabulary (`DiagnosticsEventStage`). */
const EVENT_STAGES: ReadonlySet<string> = vocabulary<DiagnosticsEventStage>({
  'resolve': true,
  'register': true,
  'register-hook': true,
  'init': true,
  'bootstrap': true,
  'listen': true,
  'stopping': true,
  'shutdown': true,
  'close': true,
  'request': true,
  'request-hook': true,
  'response-hook': true,
  'error-hook': true,
  'global': true,
  'route': true,
  'handler': true,
  'websocket-upgrade': true,
  'grpc-dispatch': true,
});

/** The fixed event-outcome vocabulary (`DiagnosticsEventOutcome`). */
const EVENT_OUTCOMES: ReadonlySet<string> = vocabulary<DiagnosticsEventOutcome>({
  'ok': true,
  'error': true,
  'short-circuit': true,
  'downstream-skipped': true,
});

/** The route-method vocabulary the kernel projects onto (`HttpMethod`). */
const NODE_METHODS: ReadonlySet<string> = vocabulary<HttpMethod>({
  'GET': true,
  'HEAD': true,
  'POST': true,
  'PUT': true,
  'PATCH': true,
  'DELETE': true,
  'OPTIONS': true,
});

/** The kernel's fixed v1 topology limits and label bound. */
const MAX_SNAPSHOT_NODES = 1024;
const MAX_SNAPSHOT_EDGES = 4096;
const MAX_LABEL_BYTES = 160;

/** An opaque node id: one kind prefix, then a canonical positive decimal. */
const NODE_ID = /^[pcrm][1-9][0-9]{0,15}$/;

/** An operation id: `op` plus a canonical decimal (`op0` is the saturation id). */
const OPERATION_ID = /^op(?:0|[1-9][0-9]{0,15})$/;

/** The kernel's bounded plugin-version grammar, within 64 characters. */
const PLUGIN_VERSION =
  /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/** Validated W3C trace and span identifiers: lowercase hex, never all-zero. */
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const NON_ZERO_HEX = /[1-9a-f]/;

/**
 * Reports whether a record carries every required key and no key outside the
 * required and optional sets.
 *
 * @param value - The record
 * @param required - Keys that must be present
 * @param optional - Keys that may be present
 * @returns `true` when the key set is within the allowlist
 */
function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  if (!required.every((key) => Object.hasOwn(value, key))) {
    return false;
  }
  return Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

/** A non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A process-instance identity field: a non-empty string, or `null` in-process. */
function isInstanceField(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

/** An approved label: at most 160 UTF-8 bytes, with no control character. */
function isNodeLabel(value: unknown): boolean {
  return typeof value === 'string' &&
    ALIAS_ENCODER.encode(value).length <= MAX_LABEL_BYTES &&
    !hasControlCharacter(value);
}

/**
 * A field the DTO types as a plain, unranged `number` that the kernel records
 * as the application set it (a middleware priority, a response status): any
 * finite number. Ranging it further would refuse honest output the kernel can
 * produce and stall every read; the kernel omits a non-finite value rather
 * than letting it serialize to `null`, so `null` is refused.
 */
function isRecordedNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A monotonic offset or elapsed time: finite and non-negative, or `null`. */
function isTiming(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

/**
 * Validates one projected node against the exact M98a DTO: the kind's own
 * field allowlist, an id minted with the kind's prefix, and every optional
 * field in its kernel-bounded shape.
 *
 * @param value - The candidate node
 * @returns `true` for a well-formed node
 */
function isNodeProjection(value: unknown): value is DiagnosticsNode {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.id !== 'string') {
    return false;
  }
  const optional = Object.hasOwn(NODE_OPTIONAL_KEYS, value.kind)
    ? NODE_OPTIONAL_KEYS[value.kind]
    : undefined;
  if (optional === undefined || !hasAllowedKeys(value, ['id', 'kind'], optional)) {
    return false;
  }
  if (!NODE_ID.test(value.id) || value.id[0] !== NODE_ID_PREFIX[value.kind]) {
    return false;
  }
  return (!Object.hasOwn(value, 'label') || isNodeLabel(value.label)) &&
    (!Object.hasOwn(value, 'version') ||
      (typeof value.version === 'string' && value.version.length <= 64 &&
        PLUGIN_VERSION.test(value.version))) &&
    (!Object.hasOwn(value, 'method') ||
      (typeof value.method === 'string' && NODE_METHODS.has(value.method))) &&
    (!Object.hasOwn(value, 'priority') || isRecordedNumber(value.priority)) &&
    (!Object.hasOwn(value, 'position') ||
      (isCount(value.position) && value.position >= 1)) &&
    (!Object.hasOwn(value, 'registered') || typeof value.registered === 'boolean');
}

/**
 * Validates one projected edge: exactly `from`/`to`/`kind`, both endpoints
 * well-formed node ids, and a kind from the fixed vocabulary.
 *
 * @param value - The candidate edge
 * @returns `true` for a well-formed edge
 */
function isEdgeProjection(value: unknown): value is DiagnosticsEdge {
  return isRecord(value) && hasExactKeys(value, ['from', 'to', 'kind']) &&
    typeof value.from === 'string' && NODE_ID.test(value.from) &&
    typeof value.to === 'string' && NODE_ID.test(value.to) &&
    typeof value.kind === 'string' && EDGE_KINDS.has(value.kind);
}

/**
 * Reports whether a parsed value is a well-formed M98a snapshot projection:
 * EXACTLY the eight snapshot keys, version `1`, a non-empty instance string
 * or `null`, the state and failure code from their fixed vocabularies, at most
 * 1,024 nodes and 4,096 edges, a non-negative safe-integer drop count, every
 * node carrying only its kind's allowlisted fields under a unique id minted
 * with its kind's prefix, and every edge joining two nodes present in the
 * same snapshot, once.
 *
 * `instanceId: null` stays valid — an in-process reader sees it before the
 * runtime assigns an identity. A paired network session refuses it separately,
 * by binding the body to the paired instance.
 *
 * @param value - The parsed JSON value
 * @returns `true` when the value is a well-formed snapshot
 * @internal
 */
export function isSnapshotProjection(value: unknown): value is DiagnosticsSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    return false;
  }
  const { nodes, edges } = value;
  if (
    value.version !== 1 ||
    !isInstanceField(value.instanceId) ||
    typeof value.state !== 'string' || !SNAPSHOT_STATES.has(value.state) ||
    (value.failureCode !== null &&
      (typeof value.failureCode !== 'string' || !FAILURE_CODES.has(value.failureCode))) ||
    typeof value.truncated !== 'boolean' ||
    !isCount(value.droppedEvents) ||
    !Array.isArray(nodes) || nodes.length > MAX_SNAPSHOT_NODES ||
    !Array.isArray(edges) || edges.length > MAX_SNAPSHOT_EDGES
  ) {
    return false;
  }
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!isNodeProjection(node) || nodeIds.has(node.id)) {
      return false;
    }
    nodeIds.add(node.id);
  }
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!isEdgeProjection(edge) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      return false;
    }
    const key = `${edge.from}|${edge.to}|${edge.kind}`;
    if (edgeKeys.has(key)) {
      return false;
    }
    edgeKeys.add(key);
  }
  return true;
}

/**
 * Validates one projected event against the exact M98a DTO: the nine required
 * keys plus only the three optional ones, every enum from its fixed
 * vocabulary, canonical operation and node ids, finite non-negative timings,
 * a finite numeric status code, and validated non-zero W3C identifiers.
 *
 * @param value - The candidate event
 * @returns `true` for a well-formed event
 */
function isEventProjection(value: unknown): value is DiagnosticsEvent {
  if (!isRecord(value) || !hasAllowedKeys(value, EVENT_REQUIRED_KEYS, EVENT_OPTIONAL_KEYS)) {
    return false;
  }
  return isCount(value.sequence) && value.sequence >= 1 &&
    typeof value.operationId === 'string' && OPERATION_ID.test(value.operationId) &&
    (value.parentOperationId === null ||
      (typeof value.parentOperationId === 'string' &&
        OPERATION_ID.test(value.parentOperationId))) &&
    typeof value.kind === 'string' && EVENT_KINDS.has(value.kind) &&
    typeof value.stage === 'string' && EVENT_STAGES.has(value.stage) &&
    (value.nodeId === null || (typeof value.nodeId === 'string' && NODE_ID.test(value.nodeId))) &&
    typeof value.outcome === 'string' && EVENT_OUTCOMES.has(value.outcome) &&
    isTiming(value.atMs) &&
    isTiming(value.durationMs) &&
    (!Object.hasOwn(value, 'statusCode') || isRecordedNumber(value.statusCode)) &&
    (!Object.hasOwn(value, 'traceId') ||
      (typeof value.traceId === 'string' && TRACE_ID.test(value.traceId) &&
        NON_ZERO_HEX.test(value.traceId))) &&
    (!Object.hasOwn(value, 'spanId') ||
      (typeof value.spanId === 'string' && SPAN_ID.test(value.spanId) &&
        NON_ZERO_HEX.test(value.spanId)));
}

/**
 * Reports whether a parsed value is a well-formed M98a batch projection:
 * EXACTLY the six batch keys, version `1`, a non-empty instance string or
 * `null`, at most 128 well-formed events whose sequences are CONSECUTIVE (the
 * kernel's ring numbers events densely and returns a contiguous window),
 * non-negative safe-integer `next` and `lost`, `next` equal to the last
 * returned sequence when the page is non-empty, and a boolean `closed`.
 *
 * This is the request-INDEPENDENT half of the cursor contract; the client
 * checks the half that depends on the cursor it sent (an empty page echoes
 * it, a returned page starts past it, and `lost` counts the gap).
 *
 * @param value - The parsed JSON value
 * @returns `true` when the value is a well-formed batch
 * @internal
 */
export function isBatchProjection(value: unknown): value is DiagnosticsBatch {
  if (!isRecord(value) || !hasExactKeys(value, BATCH_KEYS)) {
    return false;
  }
  const { events } = value;
  if (
    value.version !== 1 ||
    !isInstanceField(value.instanceId) ||
    !Array.isArray(events) || events.length > CONNECTOR_MAX_EVENT_LIMIT ||
    !isCount(value.next) ||
    !isCount(value.lost) ||
    typeof value.closed !== 'boolean'
  ) {
    return false;
  }
  let expected: number | undefined;
  for (const event of events) {
    if (!isEventProjection(event) || (expected !== undefined && event.sequence !== expected)) {
      return false;
    }
    expected = event.sequence + 1;
  }
  return expected === undefined || value.next === expected - 1;
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
 * Copies a source-supplied list into a fresh array the connector owns. Reads
 * `length` once and each index once, through the intrinsic array — never a
 * source-supplied `map`, `toJSON` or iterator — and stops at `max + 1` items,
 * so an over-budget list still fails its validator without the connector
 * walking an attacker-chosen length. Validation then runs over this copy, so
 * a getter or `toJSON` that answers differently on a second read never
 * reaches the bytes that are signed.
 *
 * @param value - The source list
 * @param max - The list's budget; one extra item is copied so the validator refuses it
 * @param project - Copies one item into connector-owned data
 * @returns The fresh copy
 * @throws {TypeError} When `value` is not an array — the caller answers `collection-failed`
 * @internal
 */
function copyList<T, R>(
  value: readonly T[],
  max: number,
  project: (item: T) => R,
): R[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Diagnostics projection: expected an array.');
  }
  const length = Math.min(value.length, max + 1);
  const copy: R[] = [];
  for (let index = 0; index < length; index++) {
    copy.push(project(value[index] as T));
  }
  return copy;
}

/**
 * Copies one list item unchanged — a primitive alias needs no projection.
 *
 * @param item - The item
 * @returns The same item
 */
function identity<T>(item: T): T {
  return item;
}

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
    observations: copyList(
      snapshot.observations,
      MAX_HEALTH_OBSERVATIONS,
      projectHealthObservation,
    ),
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
 * UTF-8 bytes. The wire rule is {@linkcode isDisplayAlias}, which adds the
 * control-character refusal.
 *
 * @param value - The candidate alias
 * @returns `true` for a well-shaped alias
 */
function isAliasShape(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const bytes = ALIAS_ENCODER.encode(value).length;
  return bytes >= 1 && bytes <= MAX_ALIAS_BYTES;
}

/**
 * Reports whether a string carries a C0/C1 control code point.
 *
 * @param value - The string to scan
 * @returns `true` when any code point is in U+0000–U+001F or U+007F–U+009F
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

/**
 * A display alias on the wire: the approved-alias shape AND no control
 * character. An inspector source is untrusted input to the connector — any
 * in-process code can register a replacement — and a control character in a
 * displayed alias could clear or forge a consumer's terminal output. The ONE
 * alias rule every inspector validator (health, configuration, queues)
 * applies on both sides of the wire.
 *
 * @param value - The candidate alias
 * @returns `true` for a displayable alias
 * @internal
 */
export function isDisplayAlias(value: unknown): value is string {
  return isAliasShape(value) && !hasControlCharacter(value);
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
  return isDisplayAlias(value.indicatorAlias) &&
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

/**
 * The fixed origin vocabulary the configuration snapshot projects onto.
 *
 * @internal
 */
const CONFIG_ORIGINS: ReadonlySet<string> = new Set(['environment', 'file', 'unknown']);

/**
 * The fixed schema-effect vocabulary the configuration snapshot projects
 * onto.
 *
 * @internal
 */
const CONFIG_SCHEMA_EFFECTS: ReadonlySet<string> = new Set([
  'not-configured',
  'validated',
  'introduced',
  'removed',
  'unknown',
]);

/** The entry keys always present; `sourceAlias` is added only when carried. */
const CONFIG_ENTRY_KEYS: readonly string[] = [
  'keyAlias',
  'origin',
  'overriddenSourceAliases',
  'expanded',
  'referenceAliases',
  'schemaEffect',
];

/** The exact snapshot keys a configuration projection carries. */
const CONFIG_SNAPSHOT_KEYS: readonly string[] = [
  'version',
  'instanceId',
  'state',
  'entries',
  'truncated',
  'droppedEntries',
];

/** The fixed upper bounds, matching the approved budgets on both sides. */
const MAX_CONFIG_ENTRIES = 128;
const MAX_CONFIG_REFERENCES = 16;
const MAX_CONFIG_OVERRIDDEN = 8;

/** Validates one bounded alias array: at most `max` display aliases. */
function isBoundedAliasArray(value: unknown, max: number): boolean {
  return Array.isArray(value) && value.length <= max && value.every(isDisplayAlias);
}

/**
 * Re-projects one provenance entry against the exact M98e field allowlist.
 * Copies field-by-field — never a spread of a provider result — so an
 * unexpected field on an internal DTO cannot reach the wire.
 *
 * @param entry - The source entry
 * @returns The projected record
 * @internal
 */
export function projectConfigEntry(entry: ConfigProvenanceEntry): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    keyAlias: entry.keyAlias,
    origin: entry.origin,
    overriddenSourceAliases: copyList(
      entry.overriddenSourceAliases,
      MAX_CONFIG_OVERRIDDEN,
      identity,
    ),
    expanded: entry.expanded,
    referenceAliases: copyList(entry.referenceAliases, MAX_CONFIG_REFERENCES, identity),
    schemaEffect: entry.schemaEffect,
  };
  copyOptional(projected, 'sourceAlias', entry.sourceAlias);
  return projected;
}

/**
 * Re-projects a configuration snapshot against the exact M98e field
 * allowlist. The body is the compact final configuration-snapshot JSON — not
 * an envelope — so the projection produces exactly the DTO's fields and no
 * others.
 *
 * @param snapshot - The source configuration snapshot
 * @returns The projected, serialization-ready record
 * @internal
 */
export function projectConfigSnapshot(
  snapshot: ConfigDiagnosticsSnapshot,
): Record<string, unknown> {
  return {
    version: snapshot.version,
    instanceId: snapshot.instanceId,
    state: snapshot.state,
    entries: copyList(snapshot.entries, MAX_CONFIG_ENTRIES, projectConfigEntry),
    truncated: snapshot.truncated,
    droppedEntries: snapshot.droppedEntries,
  };
}

/** Validates one projected provenance entry against the exact M98e DTO. */
function isConfigEntryProjection(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const carriesAlias = typeof value.origin === 'string' && value.origin === 'file' &&
    Object.hasOwn(value, 'sourceAlias');
  const keys = carriesAlias ? [...CONFIG_ENTRY_KEYS, 'sourceAlias'] : CONFIG_ENTRY_KEYS;
  if (!hasExactKeys(value, keys)) {
    return false;
  }
  // `sourceAlias` may ride only a `file` origin — an environment or unknown
  // origin carries no source alias at all, and a `file` origin may omit one
  // when its path was not approved.
  const sourceAliasOk = typeof value.origin !== 'string' || value.origin !== 'file'
    ? !Object.hasOwn(value, 'sourceAlias')
    : !Object.hasOwn(value, 'sourceAlias') || isDisplayAlias(value.sourceAlias);
  return isDisplayAlias(value.keyAlias) &&
    typeof value.origin === 'string' && CONFIG_ORIGINS.has(value.origin) &&
    sourceAliasOk &&
    isBoundedAliasArray(value.overriddenSourceAliases, MAX_CONFIG_OVERRIDDEN) &&
    typeof value.expanded === 'boolean' &&
    isBoundedAliasArray(value.referenceAliases, MAX_CONFIG_REFERENCES) &&
    typeof value.schemaEffect === 'string' && CONFIG_SCHEMA_EFFECTS.has(value.schemaEffect);
}

/**
 * Reports whether a value is a well-formed M98e configuration-snapshot
 * projection: EXACTLY the six snapshot keys, version `1`, a non-empty
 * instance string, a fixed inspector state, at most 128 entries, a
 * non-negative safe-integer drop count, and every entry carrying exactly its
 * allowed keys — `sourceAlias` present only on a `file` origin — every enum
 * from its fixed vocabulary, every alias 1–64 UTF-8 bytes, and every alias
 * array within its budget.
 *
 * ONE validator for both sides of the wire: the connector runs it over its
 * own field-by-field projection before signing (a source that violates the
 * DTO is answered `collection-failed`, so nothing unvalidated is signed),
 * and the native client runs it again before handing data to a consumer.
 *
 * @param value - The parsed JSON value, or a fresh projection
 * @returns `true` when the value is a well-formed configuration snapshot
 * @internal
 */
export function isConfigSnapshotProjection(value: unknown): value is ConfigDiagnosticsSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, CONFIG_SNAPSHOT_KEYS)) {
    return false;
  }
  return value.version === 1 &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    typeof value.state === 'string' &&
    INSPECTOR_STATES.has(value.state) &&
    Array.isArray(value.entries) &&
    value.entries.length <= MAX_CONFIG_ENTRIES &&
    typeof value.truncated === 'boolean' &&
    typeof value.droppedEntries === 'number' &&
    Number.isSafeInteger(value.droppedEntries) &&
    value.droppedEntries >= 0 &&
    value.entries.every(isConfigEntryProjection);
}
