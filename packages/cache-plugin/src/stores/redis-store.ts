/**
 * Redis-backed cache store using ioredis (lazy-loaded or injected).
 *
 * Client resolution mirrors the M10 database-plugin pattern: prefer injected
 * `options.client`; otherwise lazy `import('npm:ioredis@5.x')`.
 *
 * @module
 */
import { attachConnectionErrorReporter } from '@setu-ts/common';
import type { ConnectionErrorReporter } from '@setu-ts/common';
import type { CacheStore } from './cache-store.ts';
import type { IRedisClient } from '../interfaces/index.ts';

/**
 * Lazily load ioredis at runtime. Pin to 5.x for stability.
 *
 * @returns The ioredis constructor
 * @throws {Error} If the npm:ioredis package cannot be resolved
 */
async function loadIoredis(): Promise<typeof import('npm:ioredis@5.x').Redis> {
  const mod = await import('npm:ioredis@5.x');
  return mod.Redis;
}

/**
 * Default bound on one Redis command, in milliseconds (M101a V8-5).
 *
 * Above the ~10 s `maxRetriesPerRequest` budget that already covers a STOPPED
 * server, so it bounds only the open-but-silent connection (a paused or
 * partitioned server) and never rejects a command a reconnect was about to
 * deliver — the M98l backplane reasoning, unchanged.
 */
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 15_000;

/** The largest delay a runtime timer accepts (2^31 - 1 ms). */
const MAX_REDIS_COMMAND_TIMEOUT_MS = 2_147_483_647;

/**
 * Resolve and validate `commandTimeoutMs`.
 *
 * `NaN` (what `Number(env.X)` yields for an unset variable) would otherwise
 * reach ioredis and silently disable the bound, so it is refused with the
 * other out-of-range values. The message is fixed and never echoes the value.
 *
 * @param value - The configured bound, or `undefined` for the default
 * @returns The bound in milliseconds; `0` disables it
 * @throws {RangeError} If the value is not a number from `0` to `2147483647`
 */
export function resolveCommandTimeoutMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_REDIS_COMMAND_TIMEOUT_MS;
  if (
    typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < 0 ||
    resolved > MAX_REDIS_COMMAND_TIMEOUT_MS
  ) {
    throw new RangeError(
      'cache-plugin: options.commandTimeoutMs must be a number from 0 to ' +
        `${MAX_REDIS_COMMAND_TIMEOUT_MS} (0 disables the bound)`,
    );
  }
  return resolved;
}

/** The constructor options a lazily built client receives. */
export type LazyRedisClientOptions = {
  readonly lazyConnect: true;
  readonly commandTimeout?: number;
};

/**
 * Constructs an ioredis client without opening its socket before connect().
 *
 * @param RedisCtor - The ioredis constructor
 * @param url - Redis connection URL
 * @param commandTimeoutMs - Bound on one command; `0` omits `commandTimeout`
 *   so ioredis applies none
 * @returns The constructed client
 */
export function createLazyRedisClient(
  RedisCtor: new (url: string, options: LazyRedisClientOptions) => unknown,
  url: string,
  commandTimeoutMs: number = DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
): IRedisClient {
  const options: LazyRedisClientOptions = commandTimeoutMs === 0
    ? { lazyConnect: true }
    : { lazyConnect: true, commandTimeout: commandTimeoutMs };
  return new RedisCtor(url, options) as IRedisClient;
}

/**
 * Validate that the supplied object has the structural shape required by
 * RedisStore. Checks the exact methods RedisStore calls — no duplicates.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IRedisClient {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  // `ping` included (M90b): the reachability probe invokes it, so a client
  // missing it must be rejected here — at registration — instead of failing
  // every later health poll through `isHealthy`'s catch.
  const required = ['get', 'set', 'del', 'exists', 'scan', 'quit', 'ping'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the Redis client: prefer injected `options.client`, then lazy-load
 * ioredis from npm.
 *
 * @param url - Redis connection URL
 * @param injectedClient - Optionally injected ioredis-compatible client
 * @param reporter - Receives the BUILT client's connection errors; never
 *   attached to an injected client, which belongs to the caller
 * @param commandTimeoutMs - Bound applied to the BUILT client only; an
 *   injected client is the caller's and keeps its own configuration
 * @returns The resolved client instance
 * @throws {Error} If no client injected and ioredis cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient: IRedisClient | undefined,
  reporter: ConnectionErrorReporter | undefined,
  commandTimeoutMs: number,
): Promise<IRedisClient> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected Redis client does not match the required structural shape ' +
          '(needs: get, set, del, exists, scan, quit, ping)',
      );
    }
    return injectedClient;
  }
  const RedisCtor = await loadIoredis();
  const client = createLazyRedisClient(RedisCtor, url, commandTimeoutMs);
  if (reporter !== undefined) {
    attachConnectionErrorReporter(client, reporter);
  }
  return client;
}

/**
 * Redis-backed cache store implementation.
 *
 * Values are JSON-serialized before storage so that arbitrary types can be
 * cached. The `prefix` is applied at construction time and used exclusively
 * by `clear()` to scope the SCAN+DEL to this instance's keys.
 *
 * @since 0.1.0
 */
export class RedisStore implements CacheStore {
  #client: IRedisClient | null = null;
  #url: string;
  #injectedClient: IRedisClient | undefined;
  #prefix: string;
  #reporter: ConnectionErrorReporter | undefined;
  #commandTimeoutMs: number;
  #ready = false;

  /**
   * @param prefix - Key prefix for scoping `clear()` to this instance's keys.
   *   An empty prefix would scan `*` in clear() — acceptable only for single-
   *   tenant Redis deployments.
   * @param options - Redis connection and client options
   * @param options.url - Redis connection URL (default `redis://localhost:6379`)
   * @param options.client - Injected ioredis-compatible client (bypasses lazy import)
   * @param options.connectionErrorReporter - Receives the connection errors
   *   (`ioredis` `'error'` events) of the client this store BUILDS, instead of
   *   `ioredis` printing each one to the console. Never attached to an
   *   injected `client`. `CachePlugin` supplies one backed by its logger.
   * @param options.commandTimeoutMs - Bound on one Redis command of the client
   *   this store BUILDS (default {@link DEFAULT_REDIS_COMMAND_TIMEOUT_MS};
   *   `0` disables it). Never applied to an injected `client`.
   * @throws {RangeError} If `commandTimeoutMs` is not a number from `0` to
   *   `2147483647`
   */
  constructor(
    prefix: string,
    options?: {
      url?: string | undefined;
      client?: IRedisClient | undefined;
      connectionErrorReporter?: ConnectionErrorReporter | undefined;
      commandTimeoutMs?: number | undefined;
    },
  ) {
    this.#commandTimeoutMs = resolveCommandTimeoutMs(options?.commandTimeoutMs);
    this.#prefix = prefix;
    this.#url = options?.url ?? 'redis://localhost:6379';
    this.#injectedClient = options?.client;
    this.#reporter = options?.connectionErrorReporter;
  }

  async connect(): Promise<void> {
    this.#client = await resolveClient(
      this.#url,
      this.#injectedClient,
      this.#reporter,
      this.#commandTimeoutMs,
    );
    // Only call connect() if the client exposes it (lazy ioredis clients do).
    if (typeof this.#client.connect === 'function') {
      await this.#client.connect();
    }
    this.#ready = true;
  }

  async disconnect(): Promise<void> {
    if (this.#client) {
      await this.#client.quit();
    }
    this.#client = null;
    this.#ready = false;
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Probes Redis with a typed `ping()` (M90b). `false` after disconnect —
   * a store with no client cannot answer — and otherwise `true` only when
   * the server answers, a rejection being unreachability.
   *
   * The plugin caches and bounds this probe; this method is the raw
   * per-call question.
   *
   * @returns `true` when Redis answers `ping`
   * @since 0.5.0
   */
  async isHealthy(): Promise<boolean> {
    if (this.#client === null) {
      return false;
    }
    try {
      await this.#client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.#client) {
      return null;
    }
    const raw = await this.#client.get(key);
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // If deserialization fails, return raw string
      return raw as T;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisStore is not connected');
    }
    const serialized = JSON.stringify(value);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.#client.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await this.#client.set(key, serialized);
    }
  }

  async delete(key: string): Promise<boolean> {
    if (!this.#client) {
      return false;
    }
    const result = await this.#client.del(key);
    return result > 0;
  }

  async has(key: string): Promise<boolean> {
    if (!this.#client) {
      return false;
    }
    const result = await this.#client.exists(key);
    return result === 1;
  }

  async clear(): Promise<void> {
    if (!this.#client) {
      return;
    }
    // SCAN MATCH ${prefix}* to scope deletion to this instance's keys.
    // A bare SCAN * would wipe the whole Redis server.
    const pattern = this.#prefix ? `${this.#prefix}*` : '*';
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.#client.scan(cursor, 'MATCH', pattern);
      if (keys.length > 0) {
        await this.#client.del(...keys);
      }
      cursor = nextCursor;
    } while (cursor !== '0');
  }
}
