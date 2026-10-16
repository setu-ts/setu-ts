/** Connection-fault classification shared by backend-owning packages. @module */

/**
 * Node/net codes meaning a backend is temporarily unreachable (M90f).
 * Shared with database-plugin so Redis and database outage classification use
 * the same eight-code vocabulary.
 * @since 0.10.0
 */
export const CONNECTION_FAULT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/** Maximum number of objects inspected, including the original error. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Identifies a connection outage without mutating the thrown value.
 *
 * Measured with ioredis 5.11.1 and a throwaway Redis 7: paused with
 * commandTimeout → Error / "Command timed out"; stopped or connection-refused
 * with retries → MaxRetriesPerRequestError / "Reached the max retries per
 * request limit (which is 20). Refer to "maxRetriesPerRequest" option for
 * details." (also measured with limit 1); refused without reconnect or
 * explicitly disconnected → Error /
 * "Connection is closed."; offline queue disabled → Error / "Stream isn't
 * writeable and enableOfflineQueue options is false". All four command
 * rejections had no code and no cause. Connection refusal also emitted Error /
 * "connect ECONNREFUSED 127.0.0.1:63799" / code ECONNREFUSED, with no cause.
 *
 * Walks at most five objects, stopping at cycles. Unknown values, frozen
 * errors and throwing accessors are safe; Redis command errors such as
 * WRONGTYPE and unrelated programming errors remain unclassified.
 *
 * @param error - The thrown value, possibly wrapping a driver error as cause
 * @returns Whether a measured outage signal appears in the bounded chain
 * @since 0.10.0
 */
export function isConnectionFault(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    try {
      const entry = current as Record<string, unknown>;
      if (
        (typeof entry.code === 'string' && CONNECTION_FAULT_CODES.has(entry.code)) ||
        (typeof entry.errno === 'string' && CONNECTION_FAULT_CODES.has(entry.errno)) ||
        entry.name === 'MaxRetriesPerRequestError' ||
        (entry.name === 'Error' &&
          (entry.message === 'Command timed out' ||
            entry.message === 'Connection is closed.' ||
            entry.message === "Stream isn't writeable and enableOfflineQueue options is false"))
      ) {
        return true;
      }
      current = entry.cause;
    } catch {
      return false;
    }
  }
  return false;
}
