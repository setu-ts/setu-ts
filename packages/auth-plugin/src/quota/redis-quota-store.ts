/** Atomic weighted quotas through injected Redis EVAL. @module */
import { QuotaStoreUnavailableError } from '../errors.ts';
import type { IQuotaStore } from './quota.ts';

/** Minimal ioredis-style client; node-redis may use fromNodeRedis. @since 0.13.0 */
export interface IQuotaRedisClient {
  /** Runs constant Lua with all caller values in KEYS/ARGV. */
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** Closes the connection. */
  quit(): Promise<unknown>;
}

const RESERVE_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if ARGV[2] ~= '' and amount > tonumber(ARGV[2]) - used then
  return {0, used}
end
local next = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[3])
return {1, next}
`;

const ADJUST_SCRIPT = `
local next = redis.call('INCRBY', KEYS[1], ARGV[1])
if next < 0 then
  redis.call('SET', KEYS[1], '0')
end
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return 1
`;

/** Redis quota counters, with one atomic script per operation. @since 0.13.0 */
export class RedisQuotaStore implements IQuotaStore {
  readonly #client: IQuotaRedisClient;
  readonly #namespace: string;

  /** @param options - Injected client and required application namespace */
  constructor(options: { client: IQuotaRedisClient; namespace: string }) {
    const client: unknown = options.client;
    for (const method of ['eval', 'quit']) {
      if (
        client === null ||
        typeof client !== 'object' ||
        typeof (client as Record<string, unknown>)[method] !== 'function'
      ) {
        throw new TypeError(`RedisQuotaStore client requires ${method}`);
      }
    }
    if (typeof options.namespace !== 'string' || options.namespace.length === 0)
      throw new TypeError('RedisQuotaStore namespace must be non-empty');
    this.#client = options.client;
    this.#namespace = options.namespace;
  }

  /** @inheritdoc */
  async reserve(
    key: string,
    windowId: string,
    amount: number,
    limit: number | undefined,
    expireAt: number,
  ): Promise<{ admitted: boolean; used: number }> {
    try {
      const reply = await this.#client.eval(
        RESERVE_SCRIPT,
        1,
        `${this.#namespace}:${key}:${windowId}`,
        amount,
        limit ?? '',
        expireAt,
      );
      if (
        !Array.isArray(reply) ||
        reply.length !== 2 ||
        (reply[0] !== 0 && reply[0] !== 1) ||
        !Number.isSafeInteger(reply[1]) ||
        reply[1] < 0
      )
        throw new Error('Unexpected Redis quota reserve reply');
      return { admitted: reply[0] === 1, used: reply[1] as number };
    } catch (cause) {
      throw new QuotaStoreUnavailableError(cause);
    }
  }

  /** @inheritdoc */
  async adjust(key: string, windowId: string, delta: number, expireAt: number): Promise<void> {
    try {
      await this.#client.eval(
        ADJUST_SCRIPT,
        1,
        `${this.#namespace}:${key}:${windowId}`,
        delta,
        expireAt,
      );
    } catch (cause) {
      throw new QuotaStoreUnavailableError(cause);
    }
  }

  /** Closes the injected client. @returns Completion of QUIT */
  async close(): Promise<void> {
    await this.#client.quit();
  }
}
