/** Internal bounded cache for field-matcher results; not exported from the package. */

/** A per-matcher cache bounded by entry count AND by key length. */
export interface PathCache<V> {
  has(path: string): boolean;
  get(path: string): V | undefined;
  /** Stores the result unless the path is longer than the key bound. */
  set(path: string, value: V): void;
}

/**
 * Creates a FIFO cache of at most `maxEntries` paths, each at most `maxKeyLength`
 * UTF-16 units long.
 *
 * The key bound limits what request data can pin: field names reaching a
 * logger can come from request bodies, so an entry count alone let a few
 * hundred megabyte-sized names stay pinned until restart. Longer paths are not
 * cached; the caller recomputes them. It bounds the key's length, not what the
 * key string retains: a short substring that in-process code slices from a
 * huge string can keep its parent alive. Paths built from parsed object keys
 * or template literals are fresh strings and are not affected.
 *
 * @param maxEntries - Entries retained before the oldest is dropped
 * @param maxKeyLength - Longest path that is cached
 * @returns The cache
 */
export function createPathCache<V>(maxEntries: number, maxKeyLength: number): PathCache<V> {
  const entries = new Map<string, V>();
  return {
    has: (path) => entries.has(path),
    get: (path) => entries.get(path),
    set(path, value) {
      if (path.length > maxKeyLength) return;
      if (!entries.has(path) && entries.size === maxEntries) {
        entries.delete(entries.keys().next().value!);
      }
      entries.set(path, value);
    },
  };
}
