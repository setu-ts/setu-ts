/**
 * `KvSessionStore` — the committed {@linkcode ISessionStore} over a Workers KV
 * namespace, so a Worker can use the server-side session strategy and its
 * immediate revocation.
 *
 * @module
 */

import type { ISessionStore, SessionData } from '@setu-ts/common';
import type { IKvNamespace } from '../bindings/facades.ts';
import type { CacheClock } from './kv-cache-store.ts';
import type { EnvelopeRead } from './kv-envelope.ts';
import { decodeEnvelope, encodeEnvelope, physicalTtlSeconds } from './kv-envelope.ts';

/**
 * Options for {@linkcode KvSessionStore}.
 *
 * @since 0.2.0
 */
export interface KvSessionStoreOptions {
  /**
   * Prefix applied to every session key. Defaults to `'session:'`, so sharing
   * one namespace with a cache store is safe by default.
   */
  readonly prefix?: string;
}

/** The default key prefix — set so the store is namespace-safe unconfigured. */
const DEFAULT_PREFIX = 'session:';

/**
 * A session store backed by Workers KV.
 *
 * Constructed by the application and handed to `SessionPlugin`, not registered
 * by `CloudflarePlugin`: `SessionPluginOptions.store` is read when the plugin
 * is **constructed**, which is before any application exists, so a store
 * published in the service registry could never reach it.
 *
 * KV's eventual consistency applies. A `destroy()` propagates within seconds
 * rather than instantly, which is still strictly better than the cookie
 * strategy, where a stolen cookie stays valid until `maxAge`.
 *
 * @example
 * ```typescript
 * import { env } from 'cloudflare:workers';
 * import { createRuntimeServices } from '@setu-ts/runtime';
 * import { KvSessionStore } from '@setu-ts/cloudflare-plugin';
 *
 * const runtime = createRuntimeServices({ env });
 *
 * app.register(SessionPlugin({
 *   secret: String(env.SESSION_SECRET),
 *   mode: 'sign',
 *   store: new KvSessionStore(env.SESSIONS as IKvNamespace, runtime),
 * }));
 * ```
 * @since 0.2.0
 */
export class KvSessionStore implements ISessionStore {
  readonly #kv: IKvNamespace;
  readonly #clock: CacheClock;
  readonly #prefix: string;

  /**
   * @param kv - The KV namespace binding
   * @param clock - Wall clock; pass `IRuntimeServices`
   * @param options - Key prefix
   */
  constructor(kv: IKvNamespace, clock: CacheClock, options?: KvSessionStoreOptions) {
    this.#kv = kv;
    this.#clock = clock;
    this.#prefix = options?.prefix ?? DEFAULT_PREFIX;
  }

  async read(id: string): Promise<SessionData | null> {
    const read = await this.#read(id);

    if (read.kind === 'expired') {
      // Only this store's own expired row is swept. A key sharing the namespace
      // that this store did not write reads as a miss and is left alone.
      await this.#kv.delete(this.#key(id));
      return null;
    }
    // No `?? null` here, unlike the cache store: `SessionData` is a record, so
    // a hit's value is never null and the coalesce would be an unreachable
    // branch. A row whose `v` is literally null is not something `write` can
    // produce.
    return read.kind === 'hit' ? read.value : null;
  }

  async write(id: string, data: SessionData, ttlMs: number): Promise<void> {
    const ttlSeconds = ttlMs / 1000;
    await this.#kv.put(this.#key(id), encodeEnvelope(data, this.#clock.now() + ttlMs), {
      expirationTtl: physicalTtlSeconds(ttlSeconds),
    });
  }

  async destroy(id: string): Promise<boolean> {
    // One read, one delete: going through `read` would issue a second delete
    // for a row that had already expired.
    const read = await this.#read(id);
    await this.#kv.delete(this.#key(id));
    return read.kind === 'hit';
  }

  /**
   * Reads a row without touching it, so the caller decides whether a sweep is
   * warranted. Both entry points funnel through it.
   */
  async #read(id: string): Promise<EnvelopeRead<SessionData>> {
    return decodeEnvelope<SessionData>(await this.#kv.get(this.#key(id)), this.#clock.now());
  }

  /** Applies the key prefix. */
  #key(id: string): string {
    return `${this.#prefix}${id}`;
  }
}
