/**
 * The Redis idempotency store (tier B, plan §3.5).
 *
 * One `EVAL` per claim/settle makes the state machine atomic on the server. The
 * store owns its client (inject-or-lazy ioredis) because `ICacheStore` has no
 * atomic member. Completed records survive only under `maxmemory-policy
 * noeviction` and persistence that does not drop acknowledged writes; a
 * connect-time `CONFIG GET` warns when the policy would allow eviction.
 *
 * @module
 */
import type {
  IdempotencyClaimRequest,
  IdempotencyClaimResult,
  IdempotencySettleResult,
  IIdempotencyStore,
  ILogger,
  IRuntimeServices,
} from '@setu-ts/common';
import type { IBuiltRedisIdempotencyClient, IRedisIdempotencyClient } from '../interfaces/index.ts';
import { CLAIM_SCRIPT, COMPLETE_SCRIPT, RELEASE_SCRIPT } from './redis-scripts.ts';

/**
 * Parses a CLAIM `EVAL` reply.
 *
 * @param reply - The raw reply
 * @returns The claim result
 * @throws {Error} On a reply of an unexpected shape
 */
export function parseClaimReply(reply: unknown): IdempotencyClaimResult {
  if (!Array.isArray(reply)) throw new Error('redis idempotency store: unexpected CLAIM reply');
  const [kind, second] = reply as [unknown, unknown];
  if (kind === 'claimed' && (second === '0' || second === '1')) {
    return { outcome: 'claimed', takeover: second === '1' };
  }
  if (kind === 'completed' && typeof second === 'string') {
    return { outcome: 'completed', record: second };
  }
  if (kind === 'in-progress' && reply.length === 1) return { outcome: 'in-progress' };
  if (kind === 'fingerprint-mismatch' && reply.length === 1) {
    return { outcome: 'fingerprint-mismatch' };
  }
  throw new Error('redis idempotency store: unexpected CLAIM reply');
}

/**
 * Parses a COMPLETE/RELEASE `EVAL` reply.
 *
 * @param reply - The raw reply
 * @returns The settle result
 * @throws {Error} On a reply of an unexpected shape
 */
export function parseSettleReply(reply: unknown): IdempotencySettleResult {
  if (reply === 'settled' || reply === 'lost') return reply;
  throw new Error('redis idempotency store: unexpected reply');
}

/** Construction options for {@linkcode RedisIdempotencyStore}. */
export interface RedisIdempotencyStoreOptions {
  /** Required namespace, mixed into every store key. */
  readonly namespace: string;
  /** Key prefix. */
  readonly keyPrefix: string;
  /** The logger thunk. */
  readonly logger: () => ILogger | undefined;
  /** `true` when this store built the client (so it connects and quits it). */
  readonly ownsClient: boolean;
}

/**
 * A Redis-backed idempotency store.
 *
 * @since 0.9.0
 */
export class RedisIdempotencyStore implements IIdempotencyStore {
  /** @inheritdoc */
  readonly name = 'redis';

  readonly #client: IRedisIdempotencyClient | IBuiltRedisIdempotencyClient;
  readonly #namespace: string;
  readonly #keyPrefix: string;
  readonly #logger: () => ILogger | undefined;
  readonly #ownsClient: boolean;

  /**
   * @param client - The Redis client (injected or built)
   * @param options - The store options
   */
  constructor(
    client: IRedisIdempotencyClient | IBuiltRedisIdempotencyClient,
    options: RedisIdempotencyStoreOptions,
  ) {
    this.#client = client;
    this.#namespace = options.namespace;
    this.#keyPrefix = options.keyPrefix;
    this.#logger = options.logger;
    this.#ownsClient = options.ownsClient;
  }

  /** @inheritdoc */
  async connect(_runtime: IRuntimeServices): Promise<void> {
    if (this.#ownsClient && 'connect' in this.#client) {
      await this.#client.connect();
    }
    await this.#checkEvictionPolicy();
  }

  /** @inheritdoc */
  async claim(request: IdempotencyClaimRequest): Promise<IdempotencyClaimResult> {
    const reply = await this.#client.eval(
      CLAIM_SCRIPT,
      1,
      this.#storeKey(request.key),
      request.token,
      request.fingerprint,
      request.leaseMs,
      request.ttlMs,
    );
    return parseClaimReply(reply);
  }

  /** @inheritdoc */
  async complete(
    key: string,
    token: string,
    record: string,
    ttlMs: number,
  ): Promise<IdempotencySettleResult> {
    const reply = await this.#client.eval(
      COMPLETE_SCRIPT,
      1,
      this.#storeKey(key),
      token,
      record,
      ttlMs,
    );
    return parseSettleReply(reply);
  }

  /** @inheritdoc */
  async release(key: string, token: string): Promise<IdempotencySettleResult> {
    const reply = await this.#client.eval(RELEASE_SCRIPT, 1, this.#storeKey(key), token);
    return parseSettleReply(reply);
  }

  /** @inheritdoc */
  async isHealthy(): Promise<boolean> {
    try {
      return (await this.#client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    if (this.#ownsClient) {
      await this.#client.quit();
    }
  }

  /** `${keyPrefix}${namespace}:${key}`. */
  #storeKey(key: string): string {
    return `${this.#keyPrefix}${this.#namespace}:${key}`;
  }

  /**
   * Warns when `maxmemory-policy` would allow a completed record to be evicted.
   * A rejected or differently-shaped reply is ignored (managed Redis commonly
   * disables `CONFIG`).
   */
  async #checkEvictionPolicy(): Promise<void> {
    let reply: unknown;
    try {
      reply = await this.#client.call('CONFIG', 'GET', 'maxmemory-policy');
    } catch {
      return;
    }
    if (!Array.isArray(reply) || reply.length < 2) return;
    const policy = reply[1];
    if (typeof policy !== 'string' || policy === 'noeviction') return;
    this.#logger()?.warn(
      `redis idempotency store: maxmemory-policy is ${policy}; completed records can be evicted, which allows a duplicate`,
      { policy },
    );
  }
}
