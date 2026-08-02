/**
 * `KvSessionStore` — the committed {@linkcode ISessionStore} over a Workers KV
 * namespace, so a Worker can use the server-side session strategy and its
 * immediate revocation.
 *
 * @module
 */

import type { ISessionStore, SessionData } from '@hono-enterprise/common';
import type { IKvNamespace } from '../bindings/facades.ts';
import type { CacheClock } from './kv-cache-store.ts';
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
 * import { createRuntimeServices } from '@hono-enterprise/runtime';
 * import { KvSessionStore } from '@hono-enterprise/cloudflare-plugin';
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
    const key = this.#key(id);
    const raw = await this.#kv.get(key);
    const data = decodeEnvelope<SessionData>(raw, this.#clock.now());

    if (data === null && raw !== null) {
      await this.#kv.delete(key);
    }
    return data;
  }

  async write(id: string, data: SessionData, ttlMs: number): Promise<void> {
    const ttlSeconds = ttlMs / 1000;
    await this.#kv.put(this.#key(id), encodeEnvelope(data, this.#clock.now() + ttlMs), {
      expirationTtl: physicalTtlSeconds(ttlSeconds),
    });
  }

  async destroy(id: string): Promise<boolean> {
    const existed = (await this.read(id)) !== null;
    await this.#kv.delete(this.#key(id));
    return existed;
  }

  /** Applies the key prefix. */
  #key(id: string): string {
    return `${this.#prefix}${id}`;
  }
}
