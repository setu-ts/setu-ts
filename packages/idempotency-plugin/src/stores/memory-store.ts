/**
 * The in-process idempotency store (tier A, plan §3.16).
 *
 * Every method does ALL of its reads and writes synchronously in one
 * event-loop turn — that is the atomicity — and returns a resolved promise.
 * Capacity is refused rather than evicted: an evicted completed record would
 * silently allow a duplicate.
 *
 * @module
 */
import type {
  IdempotencyClaimRequest,
  IdempotencyClaimResult,
  IdempotencySettleResult,
  IIdempotencyStore,
  IRuntimeServices,
} from '@setu-ts/common';
import {
  DEFAULT_MEMORY_MAX_BYTES,
  DEFAULT_MEMORY_MAX_ENTRIES,
  DEFAULT_MEMORY_MAX_ENTRIES_PER_SCOPE,
  SWEEP_THROTTLE_MS,
} from '../constants.ts';

/** Options for {@linkcode MemoryIdempotencyStore}. */
export interface MemoryIdempotencyStoreOptions {
  /** Global entry cap. Default 100,000. */
  readonly maxEntries?: number;
  /** Per-scope entry cap. Default 1,000. */
  readonly maxEntriesPerScope?: number;
  /** Global byte cap (approximate). Default 67,108,864. */
  readonly maxBytes?: number;
}

/** One stored record. */
interface Entry {
  readonly state: 'p' | 'c';
  readonly fingerprint: string;
  readonly token: string | undefined;
  readonly leaseUntil: number;
  readonly expiresAt: number;
  readonly record: string | undefined;
}

/**
 * A `Map`-backed idempotency store.
 *
 * @since 0.9.0
 */
export class MemoryIdempotencyStore implements IIdempotencyStore {
  /** @inheritdoc */
  readonly name = 'memory';

  readonly #entries = new Map<string, Entry>();
  /**
   * The keys each scope holds. A scope's count is its set's size, and its
   * sweep iterates only this set, so a sweep costs at most
   * `maxEntriesPerScope` rather than the whole store (M109a audit F2). A scope
   * is deleted with its last key, so this map is bounded by the live entries.
   */
  readonly #keysByScope = new Map<string, Set<string>>();
  readonly #maxEntries: number;
  readonly #maxEntriesPerScope: number;
  readonly #maxBytes: number;
  #bytes = 0;
  #now: () => number = () => 0;
  #lastSweep = Number.NEGATIVE_INFINITY;
  /**
   * The `hrtime()` at which each scope last swept, so a scope sitting at its
   * cap rescans at most once per {@linkcode SWEEP_THROTTLE_MS} (plan §3.16).
   * A row is deleted with its scope's last entry, so this map is bounded by
   * the live entries, not by every scope that ever reached its cap (M109a
   * audit observation).
   */
  readonly #lastScopeSweep = new Map<string, number>();

  /**
   * @param options - The capacity bounds
   */
  constructor(options?: MemoryIdempotencyStoreOptions) {
    this.#maxEntries = options?.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES;
    this.#maxEntriesPerScope = options?.maxEntriesPerScope ?? DEFAULT_MEMORY_MAX_ENTRIES_PER_SCOPE;
    this.#maxBytes = options?.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
  }

  /** @inheritdoc */
  connect(runtime: IRuntimeServices): Promise<void> {
    this.#now = () => runtime.hrtime();
    return Promise.resolve();
  }

  /** @inheritdoc */
  claim(request: IdempotencyClaimRequest): Promise<IdempotencyClaimResult> {
    const now = this.#now();
    const existing = this.#liveEntry(request.key, now);
    if (existing !== undefined) {
      if (existing.fingerprint !== request.fingerprint) {
        return Promise.resolve({ outcome: 'fingerprint-mismatch' });
      }
      if (existing.state === 'c') {
        return Promise.resolve({ outcome: 'completed', record: existing.record ?? '' });
      }
      if (existing.leaseUntil > now) {
        return Promise.resolve({ outcome: 'in-progress' });
      }
      // A lapsed lease is taken over inside the claim.
      this.#remove(request.key, now);
      this.#insert(request.key, request, true);
      return Promise.resolve({ outcome: 'claimed', takeover: true });
    }

    const scopeCount = this.#keysByScope.get(request.scope)?.size ?? 0;
    if (scopeCount >= this.#maxEntriesPerScope) {
      this.#sweepScope(request.scope, now);
      if ((this.#keysByScope.get(request.scope)?.size ?? 0) >= this.#maxEntriesPerScope) {
        return Promise.resolve({ outcome: 'capacity-exceeded' });
      }
    }
    if (this.#entries.size >= this.#maxEntries || this.#bytes >= this.#maxBytes) {
      this.#sweep(now);
      if (this.#entries.size >= this.#maxEntries || this.#bytes >= this.#maxBytes) {
        return Promise.reject(
          new Error('memory idempotency store is full (maxEntries / maxBytes)'),
        );
      }
    }
    this.#insert(request.key, request, false);
    return Promise.resolve({ outcome: 'claimed', takeover: false });
  }

  /** @inheritdoc */
  complete(
    key: string,
    token: string,
    record: string,
    ttlMs: number,
  ): Promise<IdempotencySettleResult> {
    const now = this.#now();
    const entry = this.#liveEntry(key, now);
    if (entry === undefined || entry.state !== 'p' || entry.token !== token) {
      return Promise.resolve('lost');
    }
    // Retention restarts at `ttlMs` from this write. The entry stays, so the
    // scope count is unchanged.
    this.#bytes += record.length;
    this.#entries.set(key, {
      state: 'c',
      fingerprint: entry.fingerprint,
      token: undefined,
      leaseUntil: entry.leaseUntil,
      expiresAt: now + ttlMs,
      record,
    });
    return Promise.resolve('settled');
  }

  /** @inheritdoc */
  release(key: string, token: string): Promise<IdempotencySettleResult> {
    const now = this.#now();
    const entry = this.#liveEntry(key, now);
    if (entry === undefined || entry.state !== 'p' || entry.token !== token) {
      return Promise.resolve('lost');
    }
    this.#remove(key, now);
    return Promise.resolve('settled');
  }

  /** @inheritdoc */
  disconnect(): Promise<void> {
    this.#entries.clear();
    this.#keysByScope.clear();
    this.#lastScopeSweep.clear();
    this.#bytes = 0;
    return Promise.resolve();
  }

  /** Returns the entry for `key` when present and unexpired, else `undefined`. */
  #liveEntry(key: string, now: number): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.#remove(key, now);
      return undefined;
    }
    return entry;
  }

  /**
   * How many scopes the store tracks and how many sweep-throttle rows it
   * holds — the two maps the M109a audit found able to grow past the live
   * entries.
   *
   * @internal Test seam: this class is not a barrel export.
   * @returns The two map sizes
   */
  trackedScopeCounts(): { readonly scopes: number; readonly sweepRows: number } {
    return { scopes: this.#keysByScope.size, sweepRows: this.#lastScopeSweep.size };
  }

  /** Inserts or replaces an in-progress entry, updating accounting. */
  #insert(key: string, request: IdempotencyClaimRequest, replace: boolean): void {
    if (replace) this.#remove(key, this.#now());
    this.#bytes += key.length + request.fingerprint.length;
    this.#entries.set(key, {
      state: 'p',
      fingerprint: request.fingerprint,
      token: request.token,
      leaseUntil: this.#now() + request.leaseMs,
      expiresAt: this.#now() + request.ttlMs,
      record: undefined,
    });
    const scopeKey = request.scope;
    const keys = this.#keysByScope.get(scopeKey);
    if (keys === undefined) this.#keysByScope.set(scopeKey, new Set([key]));
    else keys.add(key);
    this.#scopeOfKey.set(key, scopeKey);
  }

  /** Removes an entry and decrements accounting. */
  #remove(key: string, _now: number): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= key.length + entry.fingerprint.length + (entry.record?.length ?? 0);
    if (this.#bytes < 0) this.#bytes = 0;
    const scopeKey = this.#scopeOfKey.get(key);
    this.#scopeOfKey.delete(key);
    if (scopeKey !== undefined) {
      const keys = this.#keysByScope.get(scopeKey);
      keys?.delete(key);
      if (keys === undefined || keys.size === 0) {
        this.#keysByScope.delete(scopeKey);
        this.#lastScopeSweep.delete(scopeKey);
      }
    }
  }

  /**
   * Removes every expired entry in one scope, at most once per throttle window.
   *
   * It visits only that scope's own keys, at most `maxEntriesPerScope`. It was
   * once a scan of the whole store, so every scope at its cap cost a full scan
   * per window (M109a audit F2). The throttle still applies, per scope: one
   * scope's refusals must not suppress the sweep another scope is waiting on.
   */
  #sweepScope(scope: string, now: number): void {
    const last = this.#lastScopeSweep.get(scope);
    if (last !== undefined && now - last < SWEEP_THROTTLE_MS) return;
    this.#lastScopeSweep.set(scope, now);
    const keys = this.#keysByScope.get(scope);
    if (keys === undefined) return;
    for (const key of [...keys]) {
      const entry = this.#entries.get(key);
      if (entry !== undefined && entry.expiresAt <= now) this.#remove(key, now);
    }
  }

  /** Removes every expired entry, at most once per throttle window. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < SWEEP_THROTTLE_MS) return;
    this.#lastSweep = now;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#remove(key, now);
    }
  }

  readonly #scopeOfKey = new Map<string, string>();
}
