/** Connection-fault classification shared by backend-owning packages. @module */

/**
 * Node/net codes meaning a backend is temporarily unreachable (M90f).
 * Shared with database-plugin so Redis and database outage classification use
 * the same eight-code vocabulary.
 */
const CONNECTION_FAULT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/**
 * Recognises the eight node/net codes shared by backend outage classifiers.
 * Keeps the code set private so callers cannot change classification policy.
 *
 * @param code - The driver code to inspect
 * @returns Whether the value is a string in the connection-fault code set
 * @since 0.10.0
 */
export function isConnectionFaultCode(code: unknown): boolean {
  return typeof code === 'string' && CONNECTION_FAULT_CODES.has(code);
}

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
 * Measured with node-redis 6.3.1: never-connected/closed → "The client is
 * closed"; offline queue disabled → "The client is offline"; stopped server
 * → "Socket closed unexpectedly"; connect timeout → "Connection timeout";
 * paused server with socketTimeout → "Socket timeout timeout. Expecting data,
 * but didn't receive any in 300ms." All have name "Error"; the timeout's
 * milliseconds vary with configuration. WRONGTYPE stays unclassified.
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
        isConnectionFaultCode(entry.code) ||
        isConnectionFaultCode(entry.errno) ||
        entry.name === 'MaxRetriesPerRequestError' ||
        (entry.name === 'Error' &&
          (entry.message === 'Command timed out' ||
            entry.message === 'Connection is closed.' ||
            entry.message === "Stream isn't writeable and enableOfflineQueue options is false" ||
            entry.message === 'The client is closed' ||
            entry.message === 'The client is offline' ||
            entry.message === 'Socket closed unexpectedly' ||
            entry.message === 'Connection timeout' ||
            (typeof entry.message === 'string' &&
              /^Socket timeout timeout\. Expecting data, but didn't receive any in \d+ms\.$/.test(
                entry.message,
              ))))
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
