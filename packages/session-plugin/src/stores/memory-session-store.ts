/**
 * In-process session store.
 *
 * Zero-dependency and useful for development, single-process deployments, and
 * tests. It is explicitly not a clustered store: two replicas do not share it,
 * so a session written on one is absent on the other.
 *
 * @module
 */
import type { ISessionStore, SessionData, TimerHandle } from '@hono-enterprise/common';

/** Default interval between expiry sweeps. */
const DEFAULT_SWEEP_MS = 60_000;

/**
 * Runtime capabilities the store needs.
 *
 * Deliberately has no defaults. A defaulted clock would mean reaching for
 * `Date.now()`, which is a runtime API and forbidden outside
 * `packages/runtime`; requiring injection also keeps the sweep testable without
 * waiting on real time. Same reasoning as the CLI's `CliDependencies`.
 *
 * @since 0.2.0
 */
export interface MemorySessionStoreDeps {
  /** Wall-clock milliseconds, from `IRuntimeServices.now`. */
  readonly now: () => number;
  /** Interval scheduler, from `IRuntimeServices.setInterval`. */
  readonly setInterval: (fn: () => void, ms: number) => TimerHandle;
  /** Interval canceller, from `IRuntimeServices.clearInterval`. */
  readonly clearInterval: (handle: TimerHandle) => void;
  /** Milliseconds between expiry sweeps. Default `60000`. */
  readonly sweepIntervalMs?: number;
}

/** One stored entry with its absolute expiry. */
interface Entry {
  readonly data: SessionData;
  readonly expiresAt: number;
}

/**
 * `Map`-backed {@linkcode ISessionStore}.
 *
 * @example
 * ```typescript
 * SessionPlugin({ secret, store: 'memory' });
 * ```
 * @since 0.2.0
 */
export class MemorySessionStore implements ISessionStore {
  readonly #entries = new Map<string, Entry>();
  readonly #deps: MemorySessionStoreDeps;
  readonly #timer: TimerHandle;

  /**
   * @param deps - Injected clock and timer functions
   */
  constructor(deps: MemorySessionStoreDeps) {
    this.#deps = deps;
    // Expired entries are dropped lazily on read as well; the sweep exists so
    // that sessions nobody ever revisits do not accumulate for the process's
    // lifetime.
    this.#timer = deps.setInterval(
      () => this.sweep(),
      deps.sweepIntervalMs ?? DEFAULT_SWEEP_MS,
    );
  }

  /** How many entries are currently held, expired ones included. */
  get size(): number {
    return this.#entries.size;
  }

  read(id: string): Promise<SessionData | null> {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      return Promise.resolve(null);
    }
    if (entry.expiresAt <= this.#deps.now()) {
      this.#entries.delete(id);
      return Promise.resolve(null);
    }
    // Detached copy: a caller mutating the result must not silently rewrite
    // stored state without going through `write`.
    return Promise.resolve({ ...entry.data });
  }

  write(id: string, data: SessionData, ttlMs: number): Promise<void> {
    this.#entries.set(id, { data: { ...data }, expiresAt: this.#deps.now() + ttlMs });
    return Promise.resolve();
  }

  destroy(id: string): Promise<boolean> {
    return Promise.resolve(this.#entries.delete(id));
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    // An uncleared interval keeps the process alive (AI_GUIDELINES §14.5).
    this.#deps.clearInterval(this.#timer);
    this.#entries.clear();
    return Promise.resolve();
  }

  /** Drops every expired entry. Exposed so the sweep is directly testable. */
  sweep(): void {
    const now = this.#deps.now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(id);
      }
    }
  }
}
