/** Portable refusal of an update that changes row identity. @module */
import { withHttpStatusHint } from './status-hint.ts';

/**
 * An update attempted to change a primary-key column. No write was sent.
 * The HTTP detail is fixed; diagnostics name only the entity and column.
 *
 * @example
 * ```typescript
 * if (error instanceof PrimaryKeyChangeError) {
 *   // Remove the changed primary-key field before submitting the update.
 * }
 * ```
 * @since 0.10.0
 */
export class PrimaryKeyChangeError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'PrimaryKeyChangeError';

  /**
   * @param entity - The addressed entity
   * @param column - The primary-key column being changed
   */
  constructor(entity: string, column: string) {
    super(`Entity '${entity}': an update cannot change the primary key column '${column}'.`);
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: "An update cannot change a row's primary key.",
    });
  }
}

/** Values whose database identity has a portable string representation. */
function stringComparable(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { toHexString?: unknown }).toHexString === 'function')
  );
}

/** Compare dates first, then driver-compatible scalar identities. */
function sameKey(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (stringComparable(left) && stringComparable(right)) return String(left) === String(right);
  return Object.is(left, right);
}

/**
 * Refuses a supplied primary key differing from the key addressed by an update.
 * Own, defined payload fields alone participate. Dates compare by time;
 * strings, numbers, bigints and ObjectId-like objects compare by `String`;
 * all other values compare by `Object.is`. Unknown id shapes are left to
 * the adapter's existing key validation.
 *
 * @param entity - The addressed entity
 * @param keyColumns - Its primary-key columns
 * @param id - The scalar key or record of key-column values
 * @param data - The update payload
 * @returns Nothing when the supplied key is unchanged or absent
 * @throws {PrimaryKeyChangeError} When a defined own key field differs
 * @example
 * ```typescript
 * assertPrimaryKeyUnchanged('User', ['id'], '5', { id: 5, name: 'Ada' });
 * ```
 * @since 0.10.0
 */
export function assertPrimaryKeyUnchanged(
  entity: string,
  keyColumns: readonly string[],
  id: unknown,
  data: Readonly<Record<string, unknown>>,
): void {
  const record =
    typeof id === 'object' &&
    id !== null &&
    !Array.isArray(id) &&
    !(id instanceof Date) &&
    !stringComparable(id)
      ? (id as Record<string, unknown>)
      : undefined;
  if (
    record === undefined &&
    (keyColumns.length !== 1 || !(stringComparable(id) || id instanceof Date))
  )
    return;
  if (record !== undefined && !keyColumns.every((column) => Object.hasOwn(record, column))) return;
  for (const column of keyColumns) {
    if (!Object.hasOwn(data, column)) continue;
    const value = data[column];
    if (value === undefined) continue;
    if (!sameKey(value, record === undefined ? id : record[column])) {
      throw new PrimaryKeyChangeError(entity, column);
    }
  }
}
