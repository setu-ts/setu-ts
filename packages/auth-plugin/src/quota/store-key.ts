/** Unambiguous quota storage keys. @module */

/**
 * Joins key parts with a length prefix on each, so no two distinct part tuples share a
 * key: a namespace or caller key containing `:` cannot shift a boundary into its neighbour.
 *
 * @param parts - The namespace (when any), the policy-scoped key and the window id
 * @returns The storage key, for example `3:app12:spend:tenant7:2026-01`
 */
export function quotaStoreKey(...parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}
