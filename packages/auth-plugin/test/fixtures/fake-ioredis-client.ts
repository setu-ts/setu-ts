/**
 * Fake ioredis-compatible client fixture for rate-limit store tests.
 *
 * Implements the IRateLimitRedisClient structural surface with in-memory
 * counters and per-key TTL, recording every call for assertion — mirrors
 * the cache-plugin fake-ioredis-client fixture.
 *
 * @module
 */

import type { IRateLimitRedisClient } from '../../src/stores/redis-rate-limit-store.ts';

/** A recorded client call: method name and arguments. */
export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Fake ioredis-compatible client with call tracking. */
export class FakeIoredisClient implements IRateLimitRedisClient {
  #store = new Map<string, { value: number; ttl: number }>();
  readonly calls: RecordedCall[] = [];

  incr(key: string): Promise<number> {
    this.calls.push({ method: 'incr', args: [key] });
    const existing = this.#store.get(key);
    if (existing === undefined) {
      this.#store.set(key, { value: 1, ttl: 0 });
      return Promise.resolve(1);
    }
    existing.value++;
    return Promise.resolve(existing.value);
  }

  pexpire(key: string, ms: number): Promise<number> {
    this.calls.push({ method: 'pexpire', args: [key, ms] });
    const existing = this.#store.get(key);
    if (existing !== undefined) {
      existing.ttl = ms;
    }
    return Promise.resolve(1);
  }

  pttl(key: string): Promise<number> {
    this.calls.push({ method: 'pttl', args: [key] });
    const existing = this.#store.get(key);
    if (existing === undefined) {
      return Promise.resolve(-2);
    }
    return Promise.resolve(existing.ttl > 0 ? existing.ttl : 0);
  }

  del(...keys: string[]): Promise<number> {
    this.calls.push({ method: 'del', args: keys });
    let deleted = 0;
    for (const key of keys) {
      if (this.#store.delete(key)) {
        deleted++;
      }
    }
    return Promise.resolve(deleted);
  }

  quit(): Promise<void> {
    this.calls.push({ method: 'quit', args: [] });
    this.#store.clear();
    return Promise.resolve();
  }
}
