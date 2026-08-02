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
 * The outcome of reading a key.
 *
 * Three outcomes rather than two, because a caller must be able to tell **this
 * store's expired entry** — which it may delete — from **a key this store does
 * not own**, which it must leave alone. Collapsing both into `null` makes an
 * idempotent read destructive: a store sharing a KV namespace would delete
 * another writer's row on a plain `get`, and a deliberately cached `null` would
 * delete itself on first read.
 *
 * @typeParam T - The stored value's type
 * @since 0.2.0
 */
export type EnvelopeRead<T> =
  /** A live entry. `value` may itself be `null`, if that is what was stored. */
  | { readonly kind: 'hit'; readonly value: T }
  /** This store's entry, past its logical deadline. Safe to delete. */
  | { readonly kind: 'expired' }
  /** Absent, unparseable, or not written by this store. Never delete. */
  | { readonly kind: 'miss' };

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
 * A key is recognised as this store's only when it carries **both** an own `v`
 * and an `e` that is `null` or a number. Anything else — unparseable text, a
 * bare JSON scalar, an object written by something else sharing the namespace —
 * is a `miss`, never an `expired`, so the caller does not delete it. A throw
 * would turn a foreign key into a request failure, which is a worse answer than
 * a cache miss.
 *
 * `hit` carries the stored value even when that value is `null`: a
 * deliberately cached absence is an entry, and reporting it as a miss is what
 * made a read delete it.
 *
 * @typeParam T - The expected value type
 * @param raw - The text KV returned, or `null` when the key was absent
 * @param now - Current wall-clock epoch milliseconds, from `runtime.now()`
 * @returns Whether the key is a live entry, this store's expired entry, or
 * neither
 * @since 0.2.0
 */
export function decodeEnvelope<T>(raw: string | null, now: number): EnvelopeRead<T> {
  if (raw === null) return { kind: 'miss' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'miss' };
  }

  if (typeof parsed !== 'object' || parsed === null) return { kind: 'miss' };
  const envelope = parsed as { v?: unknown; e?: unknown };

  // `v` must be an own key: JSON cannot represent `undefined`, so its absence
  // means the object was not written by this store.
  if (!Object.hasOwn(envelope, 'v')) return { kind: 'miss' };

  const expiresAt = envelope.e;
  if (expiresAt !== null && typeof expiresAt !== 'number') return { kind: 'miss' };
  if (typeof expiresAt === 'number' && expiresAt <= now) return { kind: 'expired' };

  return { kind: 'hit', value: envelope.v as T };
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
