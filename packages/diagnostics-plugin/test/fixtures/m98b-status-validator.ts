/**
 * A VERBATIM copy of the status-body validator the M98b client shipped
 * (`isStatusBody`, `packages/diagnostics-plugin/src/protocol/protocol.ts` at
 * the M98b merge). It is frozen here, not imported, so the compatibility
 * matrix keeps pinning what an OLD client does when it meets a NEW server —
 * the skew direction the M98d publication gate exists for. Do not update it
 * to match the current validator: that would make the pin vacuous.
 *
 * @module
 */

const STATUS_BODY_KEYS: readonly string[] = ['version', 'instanceId', 'expiresInMs'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The M98b status-body validator, byte-for-byte in behavior.
 *
 * @param value - The parsed JSON value
 * @returns `true` when the M98b client would accept the body
 */
export function m98bIsStatusBody(value: unknown): value is {
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
