/**
 * Shared key-resolution utilities for database adapters.
 *
 * Adapters translate between the repository-visible {@linkcode EntityKey}
 * (scalar `string`/`number` or composite record) and the column names their
 * backend understands. Two pure helpers cover every adapter path:
 *
 * - {@linkcode resolveKeyColumns} normalises a public mapping shape
 *   (`string` or `readonly string[]`) to an array.
 * - {@linkcode keyValues} projects an `EntityKey` onto those columns, refusing
 *   a scalar against a multi-column target and a record missing any column —
 *   each by name, with the offending column cited.
 *
 * @module
 */
import type { EntityKey } from '@setu-ts/common';

/**
 * Normalise a public primary-key shape to the internal `readonly string[]`
 * form an adapter's statement builders read.
 *
 * A scalar name yields a one-element array; an array passes through
 * unchanged. Both arms are exercised by existing tests, so this function has
 * no uncovered branches.
 *
 * @param primaryKey - The public mapping shape: a single column name or a list
 * @returns The normalised column list
 * @since 0.2.0
 */
export function resolveKeyColumns(
  primaryKey: string | readonly string[],
): readonly string[] {
  if (Array.isArray(primaryKey)) {
    return primaryKey;
  }
  return [primaryKey] as readonly string[];
}

/**
 * Project an {@linkcode EntityKey} onto the resolved columns, refusing by
 * name when the key shape does not match the target.
 *
 * - A **scalar** key against a **multi-column** target is refused, naming the
 *   operation and the first column it would need.
 * - A **record** key against a target that **misses any column** is refused,
 *   naming the missing column.
 *
 * Scalars against a one-column target pass through as a one-element array.
 *
 * @param id - The primary key value
 * @param columns - The resolved target columns from {@linkcode resolveKeyColumns}
 * @param operation - The repository operation being performed (for the error message)
 * @returns The key values in column order
 * @throws {Error} When the key shape does not match the target
 * @since 0.2.0
 */
export function keyValues(
  id: EntityKey,
  columns: readonly string[],
  operation: string,
): readonly (string | number)[] {
  if (typeof id === 'string' || typeof id === 'number') {
    if (columns.length > 1) {
      throw new Error(
        `Database ${operation}: entity key must be a composite record for ` +
          `multi-column target ${columns.join(', ')}, got scalar '${String(id)}'.`,
      );
    }
    return [id];
  }

  // Composite record key.
  const values: (string | number)[] = [];
  for (const column of columns) {
    const value = id[column];
    if (value === undefined) {
      throw new Error(
        `Database ${operation}: composite key is missing required column '${column}'.`,
      );
    }
    values.push(value);
  }
  return values;
}
