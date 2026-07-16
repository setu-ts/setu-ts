/**
 * Fake ioredis client for testing RedisLock.
 *
 * Records all method calls and simulates Redis operations using
 * in-memory data structures.
 *
 * @module
 */
import type { IRedisLockClient } from '../../src/interfaces/index.ts';

/**
 * Fake ioredis client implementing IRedisLockClient.
 */
export class FakeRedisClient implements IRedisLockClient {
  #store: Map<string, string> = new Map();
  #calls: Array<{ method: string; args: unknown[] }> = [];

  /**
   * All recorded method calls.
   */
  get calls(): Array<{ method: string; args: unknown[] }> {
    return [...this.#calls];
  }

  /**
   * Clear all state.
   */
  reset(): void {
    this.#calls = [];
    this.#store.clear();
  }

  // deno-lint-ignore require-await
  async set(
    key: string,
    value: string,
    option: string,
    ttl: number,
  ): Promise<string | null> {
    this.#calls.push({ method: 'set', args: [key, value, option, ttl] });

    // NX: only set if key does not exist
    if (option === 'NX' && this.#store.has(key)) {
      return null;
    }

    this.#store.set(key, value);
    return 'OK';
  }

  // deno-lint-ignore require-await
  async get(key: string): Promise<string | null> {
    this.#calls.push({ method: 'get', args: [key] });
    return this.#store.get(key) ?? null;
  }

  // deno-lint-ignore require-await
  async del(key: string): Promise<number> {
    this.#calls.push({ method: 'del', args: [key] });
    if (this.#store.has(key)) {
      this.#store.delete(key);
      return 1;
    }
    return 0;
  }

  // deno-lint-ignore require-await
  async quit(): Promise<void> {
    this.#calls.push({ method: 'quit', args: [] });
  }
}
