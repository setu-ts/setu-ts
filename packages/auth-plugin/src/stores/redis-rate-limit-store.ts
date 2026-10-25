/**
 * Redis-backed rate limit store using ioredis (lazy-loaded or injected).
 *
 * Follows the cache-plugin RedisStore seam: prefer injected client, otherwise
 * lazy `await import('ioredis')`.
 *
 * @module
 */

import {
  attachConnectionErrorReporter,
  deadlineRangeError,
  isConnectionFault,
  OptionalDependencyUnavailableError,
} from '@setu-ts/common';
import type { ConnectionErrorReporter, IRuntimeServices } from '@setu-ts/common';
import { RateLimitStoreUnavailableError } from '../errors.ts';
import type { RateLimitResult, RateLimitStore } from './rate-limit-store.ts';

/**
 * Lazily load ioredis at runtime. Pin to 5.x for stability. The import is
 * guarded in the SAME function (AI_GUIDELINES §12.2), so a bundler that
 * resolves dynamic imports at build time — esbuild inside Wrangler — leaves
 * it as a runtime import when the driver is absent.
 */
async function loadIoredis(): Promise<typeof import('ioredis').Redis> {
  try {
    const mod = await import('ioredis');
    return mod.Redis;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('ioredis', {
      requiredBy: '@setu-ts/auth-plugin',
      cause: error,
    });
  }
}

/**
 * Structural interface for the Redis client (rate-limit specific).
 *
 * Matches the methods RedisRateLimitStore actually calls: INCR, PEXPIRE, PTTL,
 * DEL, QUIT.
 */
export interface IRateLimitRedisClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<void>;
}

/**
 * Validate that the supplied object has the structural shape required by
 * RedisRateLimitStore.
 */
export function validateClient(client: unknown): client is IRateLimitRedisClient {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['incr', 'pexpire', 'pttl', 'del', 'quit'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the Redis client: prefer injected client, then lazy-load ioredis.
 * The reporter is attached only to a client built here — an injected client
 * belongs to the caller.
 */
async function resolveClient(
  url: string,
  injectedClient: IRateLimitRedisClient | undefined,
  reporter: ConnectionErrorReporter | undefined,
  commandTimeoutMs: number,
): Promise<IRateLimitRedisClient> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected Redis client does not match the required structural shape ' +
          '(needs: incr, pexpire, pttl, del, quit)',
      );
    }
    return injectedClient;
  }
  const RedisCtor = await loadIoredis();
  const client = createRateLimitRedisClient(RedisCtor, url, commandTimeoutMs);
  // Attached synchronously after construction: this client connects eagerly,
  // but a connect failure is emitted asynchronously, so none is missed.
  attachConnectionErrorReporter(client, reporter);
  return client as unknown as IRateLimitRedisClient;
}

/**
 * The namespace {@linkcode RedisRateLimitStore} prepends to every key when no
 * `keyPrefix` is supplied.
 *
 * The two sibling Redis stores in this framework both namespace and both say
 * why in their own source — `cache-plugin`'s takes a prefix as a REQUIRED
 * constructor argument, and `session-plugin`'s `CacheSessionStore` defaults one
 * so that a `clear()` from elsewhere cannot sign everybody out. The rate
 * limiter's keys are the most generic of the three (the literal string
 * `anonymous` for unidentified callers) and it had none.
 *
 * @since 0.5.0
 */
export const DEFAULT_RATE_LIMIT_KEY_PREFIX = 'setu:ratelimit:';

/**
 * Redis-backed rate limit store implementation.
 *
 * Uses INCR (creates if missing) + PEXPIRE on first increment, then PTTL to
 * derive resetTime. The store holds the runtime clock because PTTL returns a
 * relative ms-remaining value, while the contract's RateLimitResult.resetTime
 * must be an absolute epoch-ms timestamp.
 */
export class RedisRateLimitStore implements RateLimitStore {
  #client: IRateLimitRedisClient | null = null;
  #url: string;
  #injectedClient: IRateLimitRedisClient | undefined;
  #runtime: IRuntimeServices;
  #keyPrefix: string;
  #reporter: ConnectionErrorReporter | undefined;
  #commandTimeoutMs: number;

  /**
   * Builds the store. The client is resolved lazily on first use, so
   * constructing this costs no connection.
   *
   * @param options - Connection, injected client, runtime clock, key namespace
   */
  constructor(options: {
    url?: string | undefined;
    client?: IRateLimitRedisClient | undefined;
    runtime: IRuntimeServices;
    /**
     * Namespace prepended to every key this store reads and writes.
     * Defaults to {@linkcode DEFAULT_RATE_LIMIT_KEY_PREFIX}.
     *
     * `keyGenerator` produces keys such as `anonymous` and `ip:203.0.113.7`,
     * which are generic enough that two applications sharing one managed
     * Redis would count against each other's budget — service A's traffic
     * exhausting service B's limit. Pass a per-application value when one
     * Redis serves several.
     *
     * @since 0.5.0
     */
    keyPrefix?: string | undefined;
    /**
     * Receives the connection errors (`ioredis` `'error'` events) of the
     * client this store BUILDS, instead of `ioredis` printing each reconnect
     * failure to the console. Never attached to an injected `client`, which
     * belongs to the caller. This store is constructed by the application,
     * so no plugin supplies one: build it with `createConnectionErrorReporter`
     * from `@setu-ts/common` over your logger. Absent, the built client's
     * connection errors are dropped: nothing reaches the console or a log.
     *
     * @since 0.8.0
     */
    connectionErrorReporter?: ConnectionErrorReporter | undefined;
    /**
     * Bound on a built client's command, in ms; defaults to 15000.
     * 0 omits the bound. Ignored for an injected client.
     * @since 0.10.0
     */
    commandTimeoutMs?: number;
  }) {
    this.#commandTimeoutMs = resolveCommandTimeoutMs(options.commandTimeoutMs);
    this.#url = options.url ?? 'redis://localhost:6379';
    this.#injectedClient = options.client;
    this.#runtime = options.runtime;
    this.#keyPrefix = options.keyPrefix ?? DEFAULT_RATE_LIMIT_KEY_PREFIX;
    this.#reporter = options.connectionErrorReporter;
  }

  /** Namespaces a generated key. Applied at every Redis call site. */
  #namespaced(key: string): string {
    return `${this.#keyPrefix}${key}`;
  }

  /**
   * Ensure the client is resolved and connected (async).
   */
  private async ensureClient(): Promise<IRateLimitRedisClient> {
    if (this.#client !== null) {
      return this.#client;
    }
    this.#client = await resolveClient(
      this.#url,
      this.#injectedClient,
      this.#reporter,
      this.#commandTimeoutMs,
    );
    return this.#client;
  }

  async increment(key: string, windowMs: number): Promise<RateLimitResult> {
    try {
      const client = await this.ensureClient();
      const now = this.#runtime.now();
      const namespaced = this.#namespaced(key);

      // INCR returns 1 on first call (key created), >1 on subsequent calls
      const count = await client.incr(namespaced);

      // PEXPIRE only on first increment (count === 1)
      if (count === 1) {
        await client.pexpire(namespaced, windowMs);
      }

      // PTTL returns time-to-live in ms (relative); convert to absolute resetTime
      const pttl = await client.pttl(namespaced);
      const resetTime = now + pttl;

      return { count, resetTime };
    } catch (error) {
      throw isConnectionFault(error) ? new RateLimitStoreUnavailableError(error) : error;
    }
  }

  async reset(key: string): Promise<void> {
    try {
      const client = await this.ensureClient();
      await client.del(this.#namespaced(key));
    } catch (error) {
      throw isConnectionFault(error) ? new RateLimitStoreUnavailableError(error) : error;
    }
  }

  /**
   * Close the Redis connection (calls QUIT).
   */
  async disconnect(): Promise<void> {
    if (this.#client !== null) {
      await this.#client.quit();
      this.#client = null;
    }
  }
}

/** Validates the built client's command bound; internal construction seam. */
export function resolveCommandTimeoutMs(value: number | undefined): number {
  const bound = value ?? 15_000;
  // One validator for every bound (M101a): the shared check refuses NaN, a
  // non-number, a negative value and anything past the largest timer delay.
  const error = deadlineRangeError('auth-plugin: commandTimeoutMs', bound);
  if (error !== null) throw error;
  return bound;
}

/** Builds a bounded ioredis client; 0 preserves ioredis's unbounded default. */
export function createRateLimitRedisClient(
  RedisCtor: new (url: string, options?: { commandTimeout: number }) => unknown,
  url: string,
  commandTimeoutMs: number,
): IRateLimitRedisClient {
  return (
    commandTimeoutMs === 0
      ? new RedisCtor(url)
      : new RedisCtor(url, { commandTimeout: commandTimeoutMs })
  ) as IRateLimitRedisClient;
}
