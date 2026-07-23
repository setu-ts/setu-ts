/**
 * SecretsService — the {@linkcode ISecretManager} implementation registered
 * under `CAPABILITIES.SECRETS`. Wraps a {@linkcode SecretProvider} with a
 * monotonic-clock in-memory read cache.
 *
 * @module
 */
import type { ISecretManager } from '@hono-enterprise/common';
import type { SecretProvider } from '../interfaces/index.ts';

/** Default read-cache TTL in seconds. */
const DEFAULT_CACHE_TTL_SECONDS = 300;

/** One cached secret entry. */
interface CacheEntry {
  readonly value: string;
  /** Monotonic-clock expiry in milliseconds. */
  readonly expiresAt: number;
}

/**
 * Options for {@linkcode SecretsService}.
 *
 * @since 0.1.0
 */
export interface SecretsServiceOptions {
  /** Read-cache TTL in seconds. `0` disables caching. Default `300`. */
  cacheTtlSeconds?: number;
  /**
   * Monotonic clock in milliseconds (e.g. `runtime.hrtime`). Defaults to a
   * monotonic `performance.now`-free stub returning `0`, which — combined with
   * a non-zero TTL — still caches within a request but never mixes wall-clock.
   */
  clock?: () => number;
}

/**
 * Secret manager backed by a pluggable provider with a read-through cache.
 *
 * The committed `ISecretManager.get` throws when a secret is absent; providers
 * signal absence with `null`, and this service performs the `null → throw`
 * conversion so the throw contract lives in one place.
 *
 * @since 0.1.0
 */
export class SecretsService implements ISecretManager {
  readonly #provider: SecretProvider;
  readonly #cacheTtlMs: number;
  readonly #clock: () => number;
  readonly #cache = new Map<string, CacheEntry>();

  /**
   * @param provider - The backing provider adapter
   * @param options - Cache TTL and clock
   */
  constructor(provider: SecretProvider, options?: SecretsServiceOptions) {
    this.#provider = provider;
    const ttlSeconds = options?.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.#cacheTtlMs = ttlSeconds * 1000;
    this.#clock = options?.clock ?? ((): number => 0);
  }

  /**
   * Retrieves a secret, serving a fresh cache entry when present.
   *
   * @param name - Secret name (provider-specific path syntax)
   * @returns The secret value
   * @throws {Error} If the secret does not exist
   */
  async get(name: string): Promise<string> {
    const cached = this.#readCache(name);
    if (cached !== null) {
      return cached;
    }
    const value = await this.#provider.get(name);
    if (value === null) {
      throw new Error(`Secret not found: ${name}`);
    }
    this.#writeCache(name, value);
    return value;
  }

  /**
   * Reports whether a secret exists and is accessible.
   *
   * @param name - Secret name
   * @returns `true` if the secret exists
   */
  async has(name: string): Promise<boolean> {
    const cached = this.#readCache(name);
    if (cached !== null) {
      return true;
    }
    const value = await this.#provider.get(name);
    if (value === null) {
      return false;
    }
    this.#writeCache(name, value);
    return true;
  }

  /**
   * Rotates a secret to a new value and refreshes the cache entry.
   *
   * @param name - Secret name
   * @param value - The new secret value
   */
  async rotate(name: string, value: string): Promise<void> {
    await this.#provider.set(name, value);
    this.#writeCache(name, value);
  }

  /** Returns a live cached value, or `null` when missing/expired/disabled. */
  #readCache(name: string): string | null {
    if (this.#cacheTtlMs === 0) {
      return null;
    }
    const entry = this.#cache.get(name);
    if (entry === undefined) {
      return null;
    }
    if (this.#clock() >= entry.expiresAt) {
      this.#cache.delete(name);
      return null;
    }
    return entry.value;
  }

  /** Stores a value with a fresh expiry, unless caching is disabled. */
  #writeCache(name: string, value: string): void {
    if (this.#cacheTtlMs === 0) {
      return;
    }
    this.#cache.set(name, { value, expiresAt: this.#clock() + this.#cacheTtlMs });
  }
}
