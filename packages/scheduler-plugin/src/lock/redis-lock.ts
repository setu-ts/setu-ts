/**
 * Redis distributed lock implementation.
 *
 * Uses `SET key token NX PX ttl` for acquire and a token-checked
 * delete for release, following the inject-or-lazy pattern from
 * `packages/queue-plugin/src/adapters/redis-queue.ts`.
 *
 * @module
 */
import type { IDistributedLock, IRedisLockClient, RedisLockOptions } from '../interfaces/index.ts';

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
 * RedisLock. Checks the exact Redis commands used.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IRedisLockClient {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['set', 'quit', 'eval'];
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
  injectedClient?: IRedisLockClient,
): Promise<IRedisLockClient> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected Redis client does not match the required structural shape ' +
          '(needs: set, quit, eval)',
      );
    }
    return injectedClient;
  }
  const RedisCtor = await loadIoredis();
  return new RedisCtor(url) as unknown as IRedisLockClient;
}

/**
 * Redis-backed distributed lock.
 *
 * Acquires with `SET key token NX PX ttl` and releases with a
 * token-checked delete (the standard Redis lock pattern).
 */
export class RedisLock implements IDistributedLock {
  #client: IRedisLockClient | null = null;
  #options: RedisLockOptions;
  #connected = false;

  constructor(options: RedisLockOptions) {
    this.#options = options;
  }

  /**
   * Connect to the Redis backend.
   */
  async connect(): Promise<void> {
    if (this.#connected) {
      return;
    }
    this.#client = await resolveClient(this.#options.url, this.#options.client);
    this.#connected = true;
  }

  /**
   * Disconnect from the Redis backend.
   */
  async disconnect(): Promise<void> {
    try {
      if (this.#client !== null) {
        await this.#client.quit();
      }
    } finally {
      // N4 FIX: Always reset client and connected state, even if quit() rejects
      this.#client = null;
      this.#connected = false;
    }
  }

  /**
   * Attempt to acquire the lock.
   *
   * Uses `SET key token NX PX ttl` — returns the token if acquired,
   * `null` if another instance holds the lock.
   *
   * @param key - The lock key
   * @param ttlMs - Time-to-live in milliseconds
   * @returns A unique token if acquired, or `null` if held
   */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    if (this.#client === null) {
      throw new Error('RedisLock is not connected');
    }

    const token = crypto.randomUUID();
    // C2 FIX: Use 'NX', 'PX', ttlMs format that real ioredis expects
    const result = await this.#client.set(key, token, 'NX', 'PX', ttlMs);

    if (result === 'OK') {
      return token;
    }
    return null;
  }

  /**
   * Release a previously acquired lock.
   *
   * Only releases if the provided token matches the held token.
   * Uses atomic EVAL to prevent race conditions.
   *
   * @param key - The lock key
   * @param token - The token returned by `acquire`
   */
  async release(key: string, token: string): Promise<void> {
    if (this.#client === null) {
      return;
    }

    // C5 FIX: Use atomic Lua script to prevent race conditions
    // Script: if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;

    await this.#client.eval(script, 1, key, token);
    // Returns 1 if lock was released, 0 if token didn't match
  }
}
