/**
 * No-op cache store — all operations resolve immediately without effect.
 * Useful for testing and environments where caching should be disabled.
 *
 * @module
 */
import type { CacheStore } from './cache-store.ts';

/**
 * No-op implementation of CacheStore. Every method resolves without side
 * effects: reads return `null`/`false`, writes resolve void, and lifecycle
 * methods are no-ops.
 *
 * @since 0.1.0
 */
export class NoopStore implements CacheStore {
  #ready = true;

  /** The prefix parameter is accepted for interface parity but unused. */
  constructor(_prefix?: string) {
    // Intentionally empty — prefix is not used by NoopStore.
  }

  connect(): Promise<void> {
    this.#ready = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#ready = false;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Lifecycle truth (M90b): the no-op backend stores nothing, so the only
   * honest reachability answer is whether the store is connected.
   *
   * @returns `true` when connected
   * @since 0.5.0
   */
  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.#ready);
  }

  get<T>(_key: string): Promise<T | null> {
    return Promise.resolve(null);
  }

  set<T>(_key: string, _value: T, _ttlSeconds?: number): Promise<void> {
    return Promise.resolve();
  }

  delete(_key: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  has(_key: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }
}
