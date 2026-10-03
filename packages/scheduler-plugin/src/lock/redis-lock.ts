/**
 * Redis distributed lock implementation.
 *
 * Uses `SET key token NX PX ttl` for acquire and a token-checked
 * delete for release, following the inject-or-lazy pattern from
 * `packages/queue-plugin/src/adapters/redis-queue.ts`.
 *
 * @module
 */
import { attachConnectionErrorReporter } from '@setu-ts/common';
import type { ConnectionErrorReporter } from '@setu-ts/common';
import type { IDistributedLock, IRedisLockClient, RedisLockOptions } from '../interfaces/index.ts';

/**
 * The default ioredis `commandTimeout` for a client this lock BUILDS when no
 * `commandTimeoutMs` is configured (M101a V8-24) — the M98l backplane value,
 * above the roughly 10 s ioredis spends retrying a disconnected server.
 * `SchedulerPlugin` passes its own derived bound instead.
 */
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 15_000;

/** The largest delay a runtime timer accepts (2^31 - 1 ms). */
export const MAX_LOCK_TIMEOUT_MS = 2_147_483_647;

/**
 * Checks one lock-bound option, refusing what would silently disable it.
 *
 * `NaN` (what `Number(env.X)` yields for an unset variable) would otherwise
 * reach ioredis or the timer and disable the bound, so it is refused with the
 * other out-of-range values. The message is fixed and never echoes the value.
 *
 * @param name - The option path, used in the refusal message
 * @param value - The configured value
 * @returns The value, unchanged
 * @throws {RangeError} If the value is not a number from `0` to `2147483647`
 */
export function checkLockTimeout(name: string, value: number): number {
  if (
    typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
    value > MAX_LOCK_TIMEOUT_MS
  ) {
    throw new RangeError(
      `scheduler-plugin: ${name} must be a number from 0 to ${MAX_LOCK_TIMEOUT_MS} ` +
        '(0 disables the bound)',
    );
  }
  return value;
}

/** The token-checked delete: removes `KEYS[1]` only while it holds `ARGV[1]`. */
const RELEASE_SCRIPT = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;

/** The constructor options a built client receives. */
export type RedisLockClientOptions = { readonly commandTimeout: number };

/** An ioredis-compatible constructor. */
export type RedisLockClientCtor = new (url: string, options?: RedisLockClientOptions) => unknown;

/**
 * Builds the lock's own ioredis client, carrying the command bound (M101a
 * V8-24). `0` builds it with no options at all — the pre-M101a construction.
 *
 * @param RedisCtor - The ioredis constructor
 * @param url - Redis connection URL
 * @param commandTimeoutMs - ioredis `commandTimeout`; `0` omits it
 * @returns The built client
 */
export function createRedisLockClient(
  RedisCtor: RedisLockClientCtor,
  url: string,
  commandTimeoutMs: number,
): unknown {
  return commandTimeoutMs === 0
    ? new RedisCtor(url)
    : new RedisCtor(url, { commandTimeout: commandTimeoutMs });
}

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
 * @param reporter - Receives the BUILT client's connection errors; never
 *   attached to an injected client, which belongs to the caller
 * @returns The resolved client instance
 * @throws {Error} If no client injected and ioredis cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient: IRedisLockClient | undefined,
  reporter: ConnectionErrorReporter | undefined,
  commandTimeoutMs: number,
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
  const client = createRedisLockClient(
    RedisCtor as unknown as RedisLockClientCtor,
    url,
    commandTimeoutMs,
  );
  // Attached synchronously after construction: this client connects eagerly,
  // but a connect failure is emitted asynchronously, so none is missed.
  if (reporter !== undefined) {
    attachConnectionErrorReporter(
      client as Parameters<typeof attachConnectionErrorReporter>[0],
      reporter,
    );
  }
  return client as unknown as IRedisLockClient;
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
  #commandTimeoutMs: number;

  /**
   * @param options - Connection, client and command-bound options
   * @throws {RangeError} If `commandTimeoutMs` is not a number from `0` to
   *   `2147483647`
   */
  constructor(options: RedisLockOptions) {
    this.#options = options;
    this.#commandTimeoutMs = checkLockTimeout(
      'commandTimeoutMs',
      options.commandTimeoutMs ?? DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
    );
  }

  /**
   * Connect to the Redis backend.
   */
  async connect(): Promise<void> {
    if (this.#connected) {
      return;
    }
    this.#client = await resolveClient(
      this.#options.url,
      this.#options.client,
      this.#options.connectionErrorReporter,
      this.#commandTimeoutMs,
    );
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
   * A `SET` whose command promise REJECTS — a client-side `commandTimeout`
   * above all — may still have been written to the socket and applied on the
   * server, holding a lock nobody knows the token of (M101a V8-24). The token
   * is minted here, before the `SET`, so the rejection path issues the
   * token-checked release for that exact key and token on the same
   * connection: Redis applies it after the `SET` if the `SET` applied at all,
   * and the token check never touches a lock another holder took in between.
   * That release is best-effort; the original rejection is rethrown.
   *
   * @param key - The lock key
   * @param ttlMs - Time-to-live in milliseconds
   * @returns A unique token if acquired, or `null` if held
   * @throws The `SET`'s own rejection, after the best-effort release
   */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    if (this.#client === null) {
      throw new Error('RedisLock is not connected');
    }
    const client = this.#client;

    const token = crypto.randomUUID();
    let result: string | null;
    try {
      // C2 FIX: Use 'NX', 'PX', ttlMs format that real ioredis expects
      result = await client.set(key, token, 'NX', 'PX', ttlMs);
    } catch (error) {
      try {
        await client.eval(RELEASE_SCRIPT, 1, key, token);
      } catch {
        // Best-effort: a dead connection holds the key no longer than ttlMs.
      }
      throw error;
    }

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
    await this.#client.eval(RELEASE_SCRIPT, 1, key, token);
    // Returns 1 if lock was released, 0 if token didn't match
  }
}
