/**
 * Internal adapter→plugin bridge for database pool capacity (M90b).
 *
 * `DatabasePlugin` is feature-agnostic over its adapters: every built-in arm
 * and the `'custom'` arm flow through the same `IDatabaseAdapter` value, and
 * `common`'s port stays lifecycle-shaped. Pool capacity is therefore not a
 * port member — it is a symbol the Drizzle adapter attaches to itself when
 * the application configured {@linkcode DatabasePoolCapacity}-producing
 * `poolStats`, and the plugin feature-detects that symbol. Absent, the
 * health indicator carries no capacity fields; nothing else about the
 * indicator changes.
 *
 * NOT exported from `src/index.ts` — the published surface is the
 * {@linkcode DatabasePoolCapacity} type and the `DrizzleAdapterOptions.poolStats`
 * option; this module is the wiring between two files of the same package.
 *
 * @module
 * @internal
 */
import type { IDatabaseAdapter } from '@setu-ts/common';
import type { DatabasePoolCapacity } from '../interfaces/index.ts';

/**
 * Symbol key under which an adapter exposes its capacity reader.
 *
 * `Symbol.for` so two copies of the package in one process still agree on
 * the key — the same reasoning as every cross-copy brand in this repo.
 */
export const DATABASE_POOL_CAPACITY: unique symbol = Symbol.for(
  'setu-ts.database-plugin.pool-capacity',
);

/**
 * Validates a value as a {@linkcode DatabasePoolCapacity} snapshot.
 *
 * The reader returns whatever the application's `poolStats` callback
 * returned — application-owned code this package cannot type-check at the
 * boundary — so the plugin validates before publishing. Every field must be
 * a finite, non-negative counter, and `idle` cannot exceed `total` (the
 * published type documents `total` as idle + in use): a `NaN`, an infinite
 * or negative counter, or an `idle > total` pair is a broken reading, not a
 * capacity.
 *
 * @param value - The candidate snapshot
 * @returns `true` when `value` is a well-formed capacity snapshot
 */
export function isDatabasePoolCapacity(value: unknown): value is DatabasePoolCapacity {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.total === 'number' && Number.isFinite(candidate.total) &&
    candidate.total >= 0 &&
    typeof candidate.idle === 'number' && Number.isFinite(candidate.idle) &&
    candidate.idle >= 0 && candidate.idle <= candidate.total &&
    typeof candidate.waiting === 'number' && Number.isFinite(candidate.waiting) &&
    candidate.waiting >= 0;
}

/**
 * Reads the pool-capacity snapshot from an adapter that exposes the seam.
 *
 * A malformed snapshot — the application's callback returning a partial or
 * non-numeric object — is `undefined`, exactly like an adapter without the
 * seam: "cannot report capacity" and "no capacity configured" are the same
 * observable answer, and neither may publish a wrong number. A callback
 * that THROWS (a getter over a closed or faulty pool, a driver error) is
 * handled the same way: capacity is data, never a threshold, so the failure
 * is folded into the same `undefined` answer instead of rejecting the
 * health indicator that is only collecting it.
 *
 * @param adapter - The connected adapter
 * @returns The validated snapshot, or `undefined` when unavailable
 */
export function readPoolCapacity(adapter: IDatabaseAdapter): DatabasePoolCapacity | undefined {
  const reader = (adapter as unknown as Record<symbol, unknown>)[DATABASE_POOL_CAPACITY];
  if (typeof reader !== 'function') {
    return undefined;
  }
  try {
    const snapshot = (reader as () => unknown)();
    return isDatabasePoolCapacity(snapshot) ? snapshot : undefined;
  } catch {
    // Handled above: a throwing application callback means "capacity is
    // unavailable this poll", never "the database changed status".
    return undefined;
  }
}

/**
 * Whether a capacity snapshot shows a saturated pool: every connection busy
 * and at least one caller waiting (M101a V8-3).
 *
 * @param capacity - A validated snapshot from {@linkcode readPoolCapacity}
 * @returns `true` when `idle === 0 && waiting > 0`
 */
export function isSaturated(capacity: DatabasePoolCapacity): boolean {
  return capacity.idle === 0 && capacity.waiting > 0;
}

/**
 * Internal rejection of a reachability probe that was deliberately not run
 * because the pool is saturated (M101a V8-3). Never exported from the
 * package barrel; the service maps any probe rejection to `undefined`.
 */
export class PoolSaturatedProbeSkipped extends Error {
  /** Creates the skip error. */
  constructor() {
    super('Reachability probe skipped: the connection pool is saturated.');
    this.name = 'PoolSaturatedProbeSkipped';
  }
}

/**
 * Symbol key under which an adapter exposes a monotonically increasing count
 * of the queries it has seen COMPLETE (M101a V8-3 review fix). Attached beside
 * {@linkcode DATABASE_POOL_CAPACITY}, by the same adapter, for the same reason:
 * a saturated pool and a hung database both show `idle === 0 && waiting > 0`,
 * and only the second stops completing queries.
 */
export const DATABASE_QUERY_PROGRESS: unique symbol = Symbol.for(
  'setu-ts.database-plugin.query-progress',
);

/**
 * How recently a query must have been observed completing for a saturated
 * pool to read `up` rather than `degraded`, in milliseconds.
 *
 * Progress is observed per health poll, by a change in the completed-query
 * count since the previous poll, so detection of a hung database lags by at
 * most one poll interval plus this window.
 */
export const QUERY_PROGRESS_WINDOW_MS = 10_000;

/**
 * The reading an adapter returns from its {@linkcode DATABASE_QUERY_PROGRESS}
 * reader when it can no longer see every query the application runs — for
 * the Drizzle adapter, once the typed query seam has handed out the native
 * instance, whose queries never cross the adapter.
 */
export const QUERY_PROGRESS_UNOBSERVABLE = 'unobservable';

/**
 * Reads the completed-query count from an adapter that exposes the seam.
 *
 * @param adapter - The connected adapter
 * @returns The count; {@linkcode QUERY_PROGRESS_UNOBSERVABLE} when the reader
 *   returns `null` (the adapter cannot see all traffic, so a count that does
 *   not move proves nothing); or `undefined` when the adapter does not report
 *   progress or the reader returns anything else
 */
export function readQueryProgress(
  adapter: IDatabaseAdapter,
): number | typeof QUERY_PROGRESS_UNOBSERVABLE | undefined {
  const reader = (adapter as unknown as Record<symbol, unknown>)[DATABASE_QUERY_PROGRESS];
  if (typeof reader !== 'function') {
    return undefined;
  }
  const count = (reader as () => unknown)();
  if (count === null) {
    return QUERY_PROGRESS_UNOBSERVABLE;
  }
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : undefined;
}

/**
 * Tracks when an adapter's completed-query count last moved, on the caller's
 * monotonic clock, so the health indicator can tell a saturated pool that is
 * still serving from one waiting on a database that stopped answering.
 */
export class QueryProgressTracker {
  #lastCount: number | undefined;
  #lastProgressAt: number | undefined;

  /**
   * Records one poll's reading.
   *
   * The first reading has no predecessor: a non-zero count is taken as
   * progress now, so a pool saturated at the first poll gets one window's
   * benefit of the doubt; a zero count records nothing.
   *
   * @param count - A {@linkcode readQueryProgress} reading; anything but a
   *   count records nothing
   * @param nowMs - A monotonic reading (`runtime.hrtime()`)
   */
  observe(count: ReturnType<typeof readQueryProgress>, nowMs: number): void {
    if (typeof count !== 'number') {
      return;
    }
    const previous = this.#lastCount;
    this.#lastCount = count;
    if (previous === undefined ? count > 0 : count !== previous) {
      this.#lastProgressAt = nowMs;
    }
  }

  /**
   * Whether a query was observed completing within
   * {@linkcode QUERY_PROGRESS_WINDOW_MS} of `nowMs`.
   *
   * @param nowMs - A monotonic reading on the same clock as {@link observe}
   * @returns `false` when no progress has ever been observed
   */
  progressedWithin(nowMs: number): boolean {
    return this.#lastProgressAt !== undefined &&
      nowMs - this.#lastProgressAt <= QUERY_PROGRESS_WINDOW_MS;
  }
}
