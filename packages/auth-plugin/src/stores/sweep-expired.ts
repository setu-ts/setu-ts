/**
 * Shared amortised expiry sweep for in-memory auth stores.
 * Internal to auth-plugin; not exported from the package barrel.
 *
 * @module
 */

/**
 * Removes expired entries once the map reaches its sweep threshold.
 *
 * @param map - The store's entries, mutated in place
 * @param sweepAt - The size at which to sweep
 * @param isExpired - Whether an entry can be discarded
 * @returns The unchanged threshold below it, otherwise twice the surviving size,
 *   with a minimum of 1,024
 * @internal
 */
export function sweepExpired<V>(
  map: Map<string, V>,
  sweepAt: number,
  isExpired: (entry: V) => boolean,
): number {
  if (map.size < sweepAt) {
    return sweepAt;
  }
  for (const [key, entry] of map) {
    if (isExpired(entry)) {
      map.delete(key);
    }
  }
  return Math.max(1_024, map.size * 2);
}
