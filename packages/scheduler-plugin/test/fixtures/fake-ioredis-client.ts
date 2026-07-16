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
  #ttlStore: Map<string, number> = new Map(); // key -> expiry timestamp
  #checkTTLInterval: ReturnType<typeof setInterval> | null = null;

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
    this.#ttlStore.clear();
    this.#stopTTLChecker();
  }

  #startTTLChecker(): void {
    if (this.#checkTTLInterval !== null) return;
    this.#checkTTLInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, expiry] of this.#ttlStore.entries()) {
        if (now >= expiry) {
          this.#store.delete(key);
          this.#ttlStore.delete(key);
        }
      }
    }, 100);
  }

  #stopTTLChecker(): void {
    if (this.#checkTTLInterval !== null) {
      clearInterval(this.#checkTTLInterval);
      this.#checkTTLInterval = null;
    }
  }

  // deno-lint-ignore require-await
  async set(
    key: string,
    value: string,
    option: string,
    pxFlag: string,
    ttl: number,
  ): Promise<string | null> {
    this.#calls.push({ method: 'set', args: [key, value, option, pxFlag, ttl] });

    // NX: only set if key does not exist
    if (option === 'NX' && this.#store.has(key)) {
      return null;
    }

    this.#store.set(key, value);
    // C2 FIX: Honor PX (milliseconds TTL)
    if (pxFlag === 'PX' && ttl > 0) {
      const expiry = Date.now() + ttl;
      this.#ttlStore.set(key, expiry);
      this.#startTTLChecker();
    }
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
    this.#stopTTLChecker();
  }

  // deno-lint-ignore require-await
  async eval(
    script: string,
    numkeys: number,
    ...keysAndArgs: string[]
  ): Promise<number | string | null> {
    this.#calls.push({ method: 'eval', args: [script, numkeys, ...keysAndArgs] });

    // C5 FIX: Implement atomic Lua script for token-checked delete
    // Expected script: if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end
    const key = keysAndArgs[0];
    const token = keysAndArgs[1];

    const current = this.#store.get(key) ?? null;
    if (current === token) {
      this.#store.delete(key);
      this.#ttlStore.delete(key);
      return 1;
    }
    return 0;
  }
}
