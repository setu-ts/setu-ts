/**
 * `KvCacheStore` — the committed {@linkcode ICacheStore} over a Workers KV
 * namespace.
 *
 * @module
 */

import type { ICacheStore } from '@hono-enterprise/common';
import type { IKvNamespace } from '../bindings/facades.ts';
import { CloudflareUnsupportedError } from '../errors.ts';
import type { EnvelopeRead } from './kv-envelope.ts';
import { decodeEnvelope, encodeEnvelope, physicalTtlSeconds } from './kv-envelope.ts';

/** KV's maximum (and default) page size for `list`. */
const KV_LIST_PAGE_SIZE = 1000;

/** The clock shape this store needs. `IRuntimeServices` satisfies it. */
export interface CacheClock {
  /**
   * Current wall-clock time.
   *
   * @returns Milliseconds since the Unix epoch
   */
  now(): number;
}

/**
 * Options for {@linkcode KvCacheStore}.
 *
 * @since 0.2.0
 */
export interface KvCacheStoreOptions {
  /**
   * Prefix applied to every key. Required for {@linkcode KvCacheStore.clear},
   * which otherwise has no way to tell this store's keys from anything else
   * sharing the namespace.
   */
  readonly prefix?: string;
  /** TTL in seconds applied when `set` omits one. Omitted means no expiry. */
  readonly defaultTtlSeconds?: number;
}

/**
 * A cache store backed by Workers KV.
 *
 * Two platform properties are worth knowing before choosing this store over a
 * Durable Object or an origin cache:
 *
 * - **Writes are eventually consistent.** A `set` is not guaranteed visible to
 *   a read in another location immediately. KV suits read-heavy, tolerant
 *   caching, not coordination.
 * - **TTLs below 60 seconds are enforced by this store, not by KV.** The value
 *   carries its own deadline, so a short entry reads as a miss on time even
 *   though the key survives up to a minute longer. See `kv-envelope.ts`.
 *
 * @example
 * ```typescript
 * const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
 * await cache.set('user:1', user, 30); // honored at 30s despite KV's 60s floor
 * ```
 * @since 0.2.0
 */
export class KvCacheStore implements ICacheStore {
  readonly #kv: IKvNamespace;
  readonly #clock: CacheClock;
  readonly #prefix: string | undefined;
  readonly #defaultTtlSeconds: number | undefined;

  /**
   * @param kv - The KV namespace binding
   * @param clock - Wall clock; pass `IRuntimeServices`
   * @param options - Key prefix and default TTL
   */
  constructor(kv: IKvNamespace, clock: CacheClock, options?: KvCacheStoreOptions) {
    this.#kv = kv;
    this.#clock = clock;
    this.#prefix = options?.prefix;
    this.#defaultTtlSeconds = options?.defaultTtlSeconds;
  }

  async get<T>(key: string): Promise<T | null> {
    const read = await this.#read<T>(key);

    if (read.kind === 'expired') {
      // Only an entry this store owns is swept — a foreign key sharing the
      // namespace reads as a miss and is left where it is.
      await this.#kv.delete(this.#key(key));
      return null;
    }
    // A stored `null` is a hit, but `ICacheStore.get` has no way to express it
    // apart from absence, so both answer null. The distinction survives on
    // `has` and `delete`, and — the point — neither path deletes the entry.
    return read.kind === 'hit' ? read.value ?? null : null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.#defaultTtlSeconds;

    if (ttl === undefined) {
      await this.#kv.put(this.#key(key), encodeEnvelope(value, null));
      return;
    }

    const expiresAt = this.#clock.now() + ttl * 1000;
    await this.#kv.put(this.#key(key), encodeEnvelope(value, expiresAt), {
      expirationTtl: physicalTtlSeconds(ttl),
    });
  }

  async delete(key: string): Promise<boolean> {
    // KV's delete reports nothing about what it removed, so presence is read
    // first to honor the committed Promise<boolean>. One read, one delete:
    // going through `has` would issue a second delete for an expired entry.
    const read = await this.#read(key);
    await this.#kv.delete(this.#key(key));
    return read.kind === 'hit';
  }

  async has(key: string): Promise<boolean> {
    const read = await this.#read(key);

    if (read.kind === 'expired') {
      await this.#kv.delete(this.#key(key));
      return false;
    }
    return read.kind === 'hit';
  }

  /**
   * Removes every key this store owns.
   *
   * KV has no bulk delete on the binding, so this pages `list` and issues one
   * `delete` per key — linear in the number of entries, and worth avoiding on
   * a hot path.
   *
   * @throws {CloudflareUnsupportedError} When the store has no key prefix
   */
  async clear(): Promise<void> {
    if (this.#prefix === undefined) {
      throw new CloudflareUnsupportedError(
        'KvCacheStore.clear() requires a key prefix. Without one the sweep would ' +
          'delete every key in the KV namespace, including entries written by other ' +
          "stores sharing it. Configure `cache.prefix` (for example 'cache:').",
      );
    }

    let cursor: string | undefined;
    do {
      const page = await this.#kv.list({
        prefix: this.#prefix,
        limit: KV_LIST_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });

      for (const entry of page.keys) {
        await this.#kv.delete(entry.name);
      }

      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
  }

  /**
   * Reads a key without touching it.
   *
   * The single read `get`, `has`, and `delete` all funnel through, so the three
   * can never disagree about what is live — and deliberately side-effect-free,
   * so the caller decides whether a sweep is warranted.
   */
  async #read<T>(key: string): Promise<EnvelopeRead<T>> {
    return decodeEnvelope<T>(await this.#kv.get(this.#key(key)), this.#clock.now());
  }

  /** Applies the configured prefix. */
  #key(key: string): string {
    return this.#prefix === undefined ? key : `${this.#prefix}${key}`;
  }
}
