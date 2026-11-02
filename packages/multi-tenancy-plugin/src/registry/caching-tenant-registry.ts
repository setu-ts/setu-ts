/**
 * The bounded TTL cache wrapped around an instance or factory-built tenant
 * registry — one that may do I/O. Internal: not exported from `src/index.ts`.
 *
 * @module
 */
import type { ITenant, ITenantRegistry, Option } from '@setu-ts/common';
import { some } from '@setu-ts/common';
import { freezeTenant } from './static-tenant-registry.ts';

/** Default TTL of a cached hit, in milliseconds. */
export const DEFAULT_TENANT_CACHE_TTL_MS = 30_000;
/** Default maximum number of cached tenants. */
export const DEFAULT_TENANT_CACHE_MAX_ENTRIES = 1_000;
/** Default byte bound over cached keys and tenants (1 MiB). */
export const DEFAULT_TENANT_CACHE_MAX_BYTES = 1_048_576;

/** Resolved cache bounds. */
export interface CachingTenantRegistryLimits {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

/** One cached hit. */
interface CacheEntry {
  readonly tenant: ITenant;
  readonly expiresAt: number;
  readonly bytes: number;
}

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Caches `some` answers only, keyed by the REQUESTED id, under an entry AND a
 * byte bound with monotonic expiry. Misses and throws are never cached, so a
 * tenant created in the backing store is admitted on its next request.
 * Concurrent lookups of one uncached id share one in-flight promise; that map
 * is emptied as each lookup settles, so it is bounded by concurrency.
 */
export class CachingTenantRegistry implements ITenantRegistry {
  readonly #inner: ITenantRegistry;
  readonly #limits: CachingTenantRegistryLimits;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<Option<ITenant>>>();
  #bytes = 0;

  /**
   * @param inner - The registry being cached
   * @param limits - TTL and bounds, already validated
   * @param now - A MONOTONIC clock in milliseconds (`runtime.hrtime`)
   */
  constructor(inner: ITenantRegistry, limits: CachingTenantRegistryLimits, now: () => number) {
    this.#inner = inner;
    this.#limits = limits;
    this.#now = now;
  }

  /** Number of cached tenants (for tests and diagnostics). */
  get size(): number {
    return this.#entries.size;
  }

  /** Total bytes accounted to cached tenants. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Number of lookups currently in flight. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** Serves a live cached hit, else looks up (single-flight) and caches a hit. */
  lookup(id: string): Promise<Option<ITenant>> {
    const cached = this.#entries.get(id);
    if (cached !== undefined) {
      if (this.#now() < cached.expiresAt) {
        return Promise.resolve(some(cached.tenant));
      }
      this.#remove(id, cached);
    }
    const pending = this.#inFlight.get(id);
    if (pending !== undefined) return pending;

    const lookup = this.#lookupAndStore(id).finally(() => {
      this.#inFlight.delete(id);
    });
    this.#inFlight.set(id, lookup);
    return lookup;
  }

  async #lookupAndStore(id: string): Promise<Option<ITenant>> {
    const answer = await this.#inner.lookup(id);
    // A malformed answer is passed through untouched: the shared check turns
    // it into a fault. Only a well-formed hit is copied and cached.
    if (answer?.present !== true || typeof answer.value?.id !== 'string') {
      return answer;
    }
    const tenant = freezeTenant(answer.value);
    this.#store(id, tenant);
    return some(tenant);
  }

  #store(id: string, tenant: ITenant): void {
    if (this.#limits.ttlMs === 0) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(tenant);
    } catch {
      return; // a cycle or a BigInt: returned uncached
    }
    const bytes = utf8Length(id) + utf8Length(serialized);
    if (bytes > this.#limits.maxBytes) return;
    const previous = this.#entries.get(id);
    if (previous !== undefined) this.#remove(id, previous);
    this.#entries.set(id, { tenant, bytes, expiresAt: this.#now() + this.#limits.ttlMs });
    this.#bytes += bytes;
    // Evict oldest-first (Map insertion order) until both bounds hold. The new
    // entry fits `maxBytes` alone, so the loop always stops with it present.
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= this.#limits.maxEntries && this.#bytes <= this.#limits.maxBytes) {
        break;
      }
      this.#remove(key, entry);
    }
  }

  #remove(id: string, entry: CacheEntry): void {
    this.#entries.delete(id);
    this.#bytes -= entry.bytes;
  }
}
