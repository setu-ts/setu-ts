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

import type { DiagnosticsBatch, DiagnosticsEvent, DiagnosticsSnapshot } from '@setu-ts/common';

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
 * The three protocol operations' canonical targets. The events target is
 * the only one carrying a query, and only in the canonical
 * `?after=<N>&limit=<N>` form — exactly this order, both parameters, no
 * others.
 *
 * @internal
 */
export const STATUS_TARGET = '/v1/status';
export const SNAPSHOT_TARGET = '/v1/snapshot';
const EVENTS_PATH = '/v1/events';

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
  readonly op: 'status' | 'snapshot' | 'events';
  /** The exact canonical target string, byte-identical to the request's. */
  readonly canonicalTarget: string;
  /** The parsed `after` cursor (events only); `0` for the other ops. */
  readonly after: number;
  /** The parsed event limit (events only); `0` for the other ops. */
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
  if (path === EVENTS_PATH) {
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
    return {
      op: 'events',
      canonicalTarget: `${EVENTS_PATH}?${search}`,
      after,
      limit,
    };
  }
  return null;
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
 */
function isRecord(value: unknown): value is Record<string, unknown> {
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
 * The signed status body: protocol version, the bound instance UUID, and
 * the session's remaining lifetime.
 *
 * @param instanceId - The application's non-null instance UUID
 * @param expiresInMs - Remaining session lifetime in milliseconds
 * @returns The status record
 * @internal
 */
export function statusBody(
  instanceId: string,
  expiresInMs: number,
): Record<string, unknown> {
  return { version: 1, instanceId, expiresInMs };
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
export const STATUS_BODY_KEYS: readonly string[] = ['version', 'instanceId', 'expiresInMs'];

/**
 * Reports whether a parsed value is a well-formed status body: exactly the
 * three keys, version `1`, a non-empty instance string, and a finite
 * non-negative expiry.
 *
 * @param value - The parsed JSON value
 * @returns `true` when the value is a well-formed status body
 * @internal
 */
export function isStatusBody(value: unknown): value is {
  version: 1;
  instanceId: string;
  expiresInMs: number;
} {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== STATUS_BODY_KEYS.length || STATUS_BODY_KEYS.some((k) => !(k in value))) {
    return false;
  }
  return value.version === 1 &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    typeof value.expiresInMs === 'number' &&
    Number.isFinite(value.expiresInMs) &&
    value.expiresInMs >= 0;
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
