/**
 * The one TTL rule the Durable Object lock's client and object share.
 *
 * @module
 * @since 0.14.0
 */

/**
 * The longest lock TTL, in milliseconds: 2,147,483,647 (about 24.8 days), the
 * largest timer delay the runtimes accept. It keeps `now + ttlMs` well inside
 * the safe-integer range and refuses a TTL that means "hold forever".
 * @since 0.14.0
 */
export const MAX_LOCK_TTL_MS = 2_147_483_647;

/**
 * Whether `ttlMs` is a whole number of milliseconds from 1 to
 * {@linkcode MAX_LOCK_TTL_MS}.
 *
 * @param ttlMs - The requested TTL
 * @returns `true` when the lock may be granted for it
 * @since 0.14.0
 */
export function isValidLockTtl(ttlMs: unknown): ttlMs is number {
  return (
    typeof ttlMs === 'number' && Number.isInteger(ttlMs) && ttlMs >= 1 && ttlMs <= MAX_LOCK_TTL_MS
  );
}
