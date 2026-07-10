/**
 * Redis-backed cache store using ioredis (lazy-loaded or injected).
 *
 * Client resolution mirrors the M10 database-plugin pattern: prefer injected
 * `options.client`; otherwise lazy `import('npm:ioredis@5.x')`.
 *
 * @module
 */
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
  const required = ['get', 'set', 'del', 'exists', 'scan', 'quit'];
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
 * @returns The resolved client instance
 * @throws {Error} If no client injected and ioredis cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient?: IRedisClient,
): Promise<IRedisClient> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected Redis client does not match the required structural shape ' +
          '(needs: get, set, del, exists, scan, quit)',
      );
    }
    return injectedClient;
  }
  const RedisCtor = await loadIoredis();
  return new RedisCtor(url) as unknown as IRedisClient;
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
  #ready = false;

  /**
   * @param prefix - Key prefix for scoping `clear()` to this instance's keys.
   *   An empty prefix would scan `*` in clear() — acceptable only for single-
   *   tenant Redis deployments.
   * @param options - Redis connection and client options
   * @param options.url - Redis connection URL (default `redis://localhost:6379`)
   * @param options.client - Injected ioredis-compatible client (bypasses lazy import)
   */
  constructor(
    prefix: string,
    options?: { url?: string | undefined; client?: IRedisClient | undefined },
  ) {
    this.#prefix = prefix;
    this.#url = options?.url ?? 'redis://localhost:6379';
    this.#injectedClient = options?.client;
  }

  async connect(): Promise<void> {
    this.#client = await resolveClient(this.#url, this.#injectedClient);
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
