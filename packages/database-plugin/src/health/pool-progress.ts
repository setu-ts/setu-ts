/** Pool release observations shared by native and repository queries. @module */
import type { IDatabaseAdapter } from '@setu-ts/common';
import { DATABASE_QUERY_PROGRESS } from './database-capacity.ts';

/**
 * Observes pg-pool at the plugin's pool-listener registration point.
 *
 * pg-pool emits `release` with an error when a query failed or its client
 * broke; only error-free releases count, so a client-side query timeout
 * against a frozen database does not read as progress. Adapter calls the
 * adapter already counted are added on top; once the adapter reports its own
 * count unobservable (`null`, a native handle is in use) the releases alone
 * carry progress, because every query on the pool releases its client.
 * @param database - The application-owned Drizzle instance
 * @param adapter - The connected adapter whose progress seam is replaced
 * @returns The shutdown cleanup, or undefined for a client without public pg counters/events
 * @internal
 */
export function observePoolReleases(
  database: unknown,
  adapter: IDatabaseAdapter,
): (() => void) | undefined {
  if (database === null || typeof database !== 'object') return undefined;
  const client = (database as { $client?: unknown }).$client;
  if (client === null || typeof client !== 'object') return undefined;
  const pool = client as {
    totalCount?: unknown;
    idleCount?: unknown;
    waitingCount?: unknown;
    on?: (event: string, listener: (error?: unknown) => void) => unknown;
    removeListener?: (event: string, listener: (error?: unknown) => void) => unknown;
  };
  if (
    typeof pool.totalCount !== 'number' ||
    typeof pool.idleCount !== 'number' ||
    typeof pool.waitingCount !== 'number' ||
    typeof pool.on !== 'function' ||
    typeof pool.removeListener !== 'function'
  )
    return undefined;
  const seams = adapter as unknown as Record<symbol, unknown>;
  const previous = seams[DATABASE_QUERY_PROGRESS];
  let completed = 0;
  const released = (error?: unknown): void => {
    if (error === undefined || error === null || error === false) completed++;
  };
  pool.on('release', released);
  seams[DATABASE_QUERY_PROGRESS] = (): number => {
    const own = typeof previous === 'function' ? (previous as () => unknown)() : undefined;
    return completed + (typeof own === 'number' ? own : 0);
  };
  return () => {
    pool.removeListener!('release', released);
    seams[DATABASE_QUERY_PROGRESS] = previous;
  };
}
