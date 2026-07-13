/**
 * Fake ioredis client for testing RedisQueue.
 *
 * Records all method calls and simulates Redis operations using
 * in-memory data structures.
 *
 * @module
 */

import type { IRedisQueueClient } from '../../src/interfaces/index.ts';

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
    offset?: number,
    limit?: number,
  ): Promise<string[]> {
    this.#record('zrangebyscore', [key, min, max, offset, limit].filter((v) => v !== undefined));

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

    // Apply offset and limit
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : members.length;
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
}
