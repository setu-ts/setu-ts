/**
 * Fake ioredis client for testing RedisQueue.
 *
 * Records all method calls and simulates Redis operations using
 * in-memory data structures.
 *
 * @module
 */

import type { IRedisQueueClient } from '../../src/interfaces/index.ts';
import {
  ACK_SCRIPT,
  DEAD_LETTER_SCRIPT,
  ENQUEUE_SCRIPT,
  REQUEUE_SCRIPT,
  RESERVE_SCRIPT,
} from '../../src/adapters/redis-queue-scripts.ts';

/**
 * Options for the fake Redis client.
 */
export interface FakeRedisOptions {
  /** Whether to reject connect(). */
  rejectConnect?: boolean;
  /** Pre-seeded data for testing. */
  seededData?: Map<string, Map<string, string>>; // key -> (field -> value)
}

/**
 * Fake ioredis client implementing IRedisQueueClient.
 */
export class FakeRedisClient implements IRedisQueueClient {
  #options: FakeRedisOptions;
  #zsets: Map<string, Map<string, number>>; // key -> (member -> score)
  #hashes: Map<string, Map<string, string>>; // key -> (field -> value)
  #calls: Array<{ method: string; args: unknown[] }>;
  #connected = false;

  constructor(options: FakeRedisOptions = {}) {
    this.#options = options;
    this.#zsets = new Map();
    this.#hashes = options.seededData ?? new Map();
    this.#calls = [];
  }

  /**
   * Records a method call.
   */
  #record(method: string, args: unknown[]): void {
    this.#calls.push({ method, args: [...args] });
  }

  /**
   * All recorded method calls.
   */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  /**
   * Whether the client is connected.
   */
  get connected(): boolean {
    return this.#connected;
  }

  /**
   * Clear all state.
   */
  reset(): void {
    this.#calls = [];
    this.#connected = false;
  }

  /**
   * Clear all data.
   */
  clearData(): void {
    this.#zsets.clear();
    this.#hashes.clear();
  }

  // deno-lint-ignore require-await
  async connect(): Promise<void> {
    this.#record('connect', []);

    if (this.#options.rejectConnect) {
      throw new Error('Connection refused');
    }

    this.#connected = true;
  }

  // deno-lint-ignore require-await
  async quit(): Promise<void> {
    this.#record('quit', []);
    this.#connected = false;
  }

  // deno-lint-ignore require-await
  async zadd(key: string, score: number, member: string): Promise<number> {
    this.#record('zadd', [key, score, member]);

    if (!this.#connected) {
      throw new Error('Not connected');
    }

    if (!this.#zsets.has(key)) {
      this.#zsets.set(key, new Map());
    }

    const zset = this.#zsets.get(key)!;

    // Return 1 if new member, 0 if updated
    const isNew = !zset.has(member);
    zset.set(member, score);

    return isNew ? 1 : 0;
  }

  // deno-lint-ignore require-await
  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    ...limitClause: readonly ['LIMIT', number, number] | readonly []
  ): Promise<string[]> {
    this.#record('zrangebyscore', [key, min, max, ...limitClause]);

    if (!this.#connected) {
      throw new Error('Not connected');
    }

    const zset = this.#zsets.get(key);
    if (!zset) {
      return [];
    }

    // Parse min/max
    const minVal = min === '-inf' ? -Infinity : Number(min);
    const maxVal = max === '+inf' ? Infinity : Number(max);

    // Filter members by score
    const members: Array<{ member: string; score: number }> = [];
    for (const [member, score] of zset.entries()) {
      if (score >= minVal && score <= maxVal) {
        members.push({ member, score });
      }
    }

    // Sort by score
    members.sort((a, b) => a.score - b.score);

    // Apply offset and limit from LIMIT clause
    let start = 0;
    let end = members.length;
    if (limitClause.length === 3 && limitClause[0] === 'LIMIT') {
      start = limitClause[1];
      end = start + limitClause[2];
    }
    const sliced = members.slice(start, end);

    return sliced.map((m) => m.member);
  }

  // deno-lint-ignore require-await
  async zrem(key: string, ...members: string[]): Promise<number> {
    this.#record('zrem', [key, ...members]);

    if (!this.#connected) {
      throw new Error('Not connected');
    }

    const zset = this.#zsets.get(key);
    if (!zset) {
      return 0;
    }

    let removed = 0;
    for (const member of members) {
      if (zset.has(member)) {
        zset.delete(member);
        removed++;
      }
    }

    return removed;
  }

  // deno-lint-ignore require-await
  async hset(key: string, field: string, value: string): Promise<number> {
    this.#record('hset', [key, field, value]);

    if (!this.#connected) {
      throw new Error('Not connected');
    }

    if (!this.#hashes.has(key)) {
      this.#hashes.set(key, new Map());
    }

    const hash = this.#hashes.get(key)!;

    const isNew = !hash.has(field);
    hash.set(field, value);

    return isNew ? 1 : 0;
  }

  // deno-lint-ignore require-await
  async hget(key: string, field: string): Promise<string | null> {
    this.#record('hget', [key, field]);

    if (!this.#connected) {
      throw new Error('Not connected');
    }

    const hash = this.#hashes.get(key);
    if (!hash) {
      return null;
    }

    return hash.get(field) ?? null;
  }

  // deno-lint-ignore require-await
  async hdel(key: string, ...fields: string[]): Promise<number> {
    this.#record('hdel', [key, ...fields]);

    if (!this.#connected) {
      throw new Error('Not connected');
    }

    const hash = this.#hashes.get(key);
    if (!hash) {
      return 0;
    }

    let deleted = 0;
    for (const field of fields) {
      if (hash.has(field)) {
        hash.delete(field);
        deleted++;
      }
    }

    return deleted;
  }

  // deno-lint-ignore require-await
  async del(...keys: string[]): Promise<number> {
    this.#record('del', keys);

    if (!this.#connected) {
      throw new Error('Not connected');
    }

    let deleted = 0;
    for (const key of keys) {
      if (this.#zsets.has(key)) {
        this.#zsets.delete(key);
        deleted++;
      }
      if (this.#hashes.has(key)) {
        this.#hashes.delete(key);
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * Counts a sorted set's members, as `ZCARD` does. A key that does not exist
   * is zero rather than an error — Redis's own behaviour, and the distinction
   * matters because the health indicator must be able to report an empty queue.
   */
  // deno-lint-ignore require-await
  async zcard(key: string): Promise<number> {
    this.#record('zcard', [key]);

    if (!this.#connected) {
      throw new Error('Not connected');
    }

    return this.#zsets.get(key)?.size ?? 0;
  }

  /**
   * Records an `EXPIRE`. The fake does not actually expire anything — the tests
   * assert the command was issued with the right TTL, which is what the adapter
   * controls; enforcing the deadline is Redis's job.
   *
   * @returns `1` when the key exists, `0` otherwise, matching Redis
   */
  // deno-lint-ignore require-await
  async expire(key: string, seconds: number): Promise<number> {
    this.#record('expire', [key, seconds]);

    if (!this.#connected) {
      throw new Error('Not connected');
    }

    return this.#zsets.has(key) || this.#hashes.has(key) ? 1 : 0;
  }
}

/**
 * A {@link FakeRedisClient} that also exposes `eval`, so `RedisQueue` takes its
 * atomic-script path. Each known script is reproduced with the fake's own
 * commands in the order the Lua runs them; an unknown script rejects, as Redis
 * would for a script it cannot run. The real scripts are executed against a
 * live Redis by `redis-atomic-transitions-real.test.ts`.
 */
export class FakeEvalRedisClient extends FakeRedisClient {
  /** Every `eval` call, as `[script, numKeys, ...keysAndArgs]`. */
  readonly evals: Array<readonly unknown[]> = [];

  async eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown> {
    this.evals.push([script, numKeys, ...keysAndArgs]);
    const keys = keysAndArgs.slice(0, numKeys).map(String);
    const args = keysAndArgs.slice(numKeys).map(String);
    switch (script) {
      case ENQUEUE_SCRIPT:
        await this.hset(keys[0], args[0], args[1]);
        await this.zadd(keys[1], Number(args[2]), args[0]);
        return 1;
      case RESERVE_SCRIPT: {
        const ids = await this.zrangebyscore(keys[0], '-inf', args[0], 'LIMIT', 0, Number(args[1]));
        const out: string[] = [];
        for (const id of ids) {
          await this.zrem(keys[0], id);
          await this.zadd(keys[1], Number(args[0]), id);
          const raw = await this.hget(keys[2], id);
          if (raw !== null) {
            out.push(raw);
          }
        }
        return out;
      }
      case ACK_SCRIPT:
        await this.zrem(keys[0], args[0]);
        await this.hdel(keys[1], args[0]);
        return 1;
      case REQUEUE_SCRIPT:
        await this.hset(keys[0], args[0], args[1]);
        await this.zrem(keys[1], args[0]);
        await this.zadd(keys[2], Number(args[2]), args[0]);
        return 1;
      case DEAD_LETTER_SCRIPT: {
        await this.zrem(keys[0], args[0]);
        if (args[2] === '1') {
          const raw = await this.hget(keys[2], args[0]);
          if (raw !== null) {
            await this.hset(keys[3], args[0], raw);
            await this.hdel(keys[2], args[0]);
          }
        }
        await this.zadd(keys[1], Number(args[1]), args[0]);
        return 1;
      }
      default:
        throw new Error('ERR unknown script');
    }
  }
}
