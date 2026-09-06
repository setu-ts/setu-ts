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
 * a finite number: a `NaN` or infinite counter is a broken reading, not a
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
    typeof candidate.idle === 'number' && Number.isFinite(candidate.idle) &&
    typeof candidate.waiting === 'number' && Number.isFinite(candidate.waiting);
}

/**
 * Reads the pool-capacity snapshot from an adapter that exposes the seam.
 *
 * A malformed snapshot — the application's callback returning a partial or
 * non-numeric object — is `undefined`, exactly like an adapter without the
 * seam: "cannot report capacity" and "no capacity configured" are the same
 * observable answer, and neither may publish a wrong number.
 *
 * @param adapter - The connected adapter
 * @returns The validated snapshot, or `undefined` when unavailable
 */
export function readPoolCapacity(adapter: IDatabaseAdapter): DatabasePoolCapacity | undefined {
  const reader = (adapter as unknown as Record<symbol, unknown>)[DATABASE_POOL_CAPACITY];
  if (typeof reader !== 'function') {
    return undefined;
  }
  const snapshot = (reader as () => unknown)();
  return isDatabasePoolCapacity(snapshot) ? snapshot : undefined;
}
