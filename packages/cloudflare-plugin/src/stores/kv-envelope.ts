/**
 * The value envelope both KV-backed stores write, and the TTL arithmetic that
 * reconciles an unbounded logical TTL with KV's 60-second physical floor.
 *
 * Workers KV rejects an `expirationTtl` below **60 seconds**, while
 * `ICacheStore.set(key, value, ttlSeconds)` and `ISessionStore.write(id, data,
 * ttlMs)` both accept anything. Writing a 5-second entry with the floored TTL
 * and nothing else would serve it for a full minute — stale data that no test
 * against a fake KV would notice, because a fake honors whatever it is told.
 *
 * So expiry is carried twice: a **logical** deadline inside the value, checked
 * on every read against the runtime clock, and a **physical** `expirationTtl`
 * at or above the floor that lets KV reclaim the key on its own. Logical expiry
 * is authoritative; physical expiry is garbage collection.
 *
 * @module
 */

/** KV's documented minimum for `expirationTtl`, in seconds. */
export const KV_MIN_EXPIRATION_TTL_SECONDS = 60;

/**
 * A stored value together with its logical deadline.
 *
 * @typeParam T - The stored value's type
 * @since 0.2.0
 */
export interface KvEnvelope<T> {
  /** The stored value. */
  readonly v: T;
  /** Epoch milliseconds at which the entry expires; `null` means never. */
  readonly e: number | null;
}

/**
 * Serializes a value and its logical deadline.
 *
 * @typeParam T - The stored value's type
 * @param value - The value to store
 * @param expiresAt - Epoch milliseconds of expiry, or `null` for no expiry
 * @returns The JSON text to hand to KV
 * @since 0.2.0
 */
export function encodeEnvelope<T>(value: T, expiresAt: number | null): string {
  const envelope: KvEnvelope<T> = { v: value, e: expiresAt };
  return JSON.stringify(envelope);
}

/**
 * Parses an envelope and applies its logical deadline.
 *
 * Anything that is not a live envelope reads as a miss: unparseable text, a
 * shape without the `e` field (a key written by something other than this
 * store, sharing the namespace), and an entry whose deadline has passed. A
 * throw would turn a foreign key into a request failure, which is a worse
 * answer than a cache miss.
 *
 * @typeParam T - The expected value type
 * @param raw - The text KV returned, or `null` when the key was absent
 * @param now - Current wall-clock epoch milliseconds, from `runtime.now()`
 * @returns The live value, or `null` on any form of miss
 * @since 0.2.0
 */
export function decodeEnvelope<T>(raw: string | null, now: number): T | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as { v?: unknown; e?: unknown };
  const expiresAt = envelope.e;

  if (expiresAt !== null && typeof expiresAt !== 'number') return null;
  if (typeof expiresAt === 'number' && expiresAt <= now) return null;

  return envelope.v as T;
}

/**
 * Floors a logical TTL to the physical `expirationTtl` KV will accept.
 *
 * Fractional seconds round **up**, so a 0.5-second TTL never becomes a
 * zero-second one, and the result is never below
 * {@linkcode KV_MIN_EXPIRATION_TTL_SECONDS}.
 *
 * @param ttlSeconds - The caller's logical TTL in seconds
 * @returns The `expirationTtl` to pass to `put`
 * @since 0.2.0
 */
export function physicalTtlSeconds(ttlSeconds: number): number {
  return Math.max(KV_MIN_EXPIRATION_TTL_SECONDS, Math.ceil(ttlSeconds));
}
