/**
 * Shared keyset-cursor helpers for the adapters that implement
 * {@linkcode IDataSource.findPage}.
 *
 * Every adapter mints its next-page cursor the same way — from the LAST row of
 * a non-terminal page, carrying the value of every ordered field plus the
 * primary-key column values plus a stable fingerprint of the resolved sort —
 * so these two helpers are the ONE implementation every in-package `findPage`
 * calls. A fingerprint format that drifted between adapters would silently
 * refuse every cursor carried from one backend to another.
 *
 * @module
 */
import type { OrderDirection } from '@setu-ts/common';
import { encodeCursor } from '@setu-ts/common';

/**
 * Build the stable sort fingerprint embedded in every minted cursor.
 *
 * The fingerprint must be stable across all calls with the same sort — a
 * cursor minted under one sort and presented under another carries a
 * different fingerprint and is refused by name rather than served a silently
 * wrong page.
 *
 * @param orderBy - The resolved sort specification
 * @returns A stable fingerprint string (`'field:direction'` pairs joined by
 *   commas, in `orderBy` declaration order)
 * @since 0.2.0
 */
export function sortFingerprint(
  orderBy: Readonly<Record<string, OrderDirection>>,
): string {
  return Object.entries(orderBy).map(([field, direction]) => `${field}:${direction}`).join(',');
}

/**
 * Mint the next-page cursor from the last row of a non-terminal page.
 *
 * The cursor is only ever produced when {@linkcode hasMore} is true AND the
 * page is non-empty: on a terminal page there is no next row to continue to,
 * and reading the ordered/key values off an empty page would crash on the
 * missing last row.
 *
 * @param pageRows - The rows of the page about to be returned (empty is fine)
 * @param orderBy - The resolved sort specification
 * @param keyColumns - The primary-key columns for cursor minting
 * @param fingerprint - The sort fingerprint to embed in the cursor
 * @param hasMore - Whether a further page exists
 * @returns The encoded cursor, or `null` when the page is terminal
 * @since 0.2.0
 */
export function mintNextCursor(
  pageRows: readonly Record<string, unknown>[],
  orderBy: Readonly<Record<string, OrderDirection>>,
  keyColumns: readonly string[],
  fingerprint: string,
  hasMore: boolean,
): string | null {
  if (!hasMore || pageRows.length === 0) return null;
  const lastRow = pageRows[pageRows.length - 1];
  const orderedValues = Object.entries(orderBy).map(
    ([field]) => lastRow[field] as string | number,
  );
  const keyValues = keyColumns.map((col) => lastRow[col] as string | number);
  return encodeCursor({ orderedValues, keyValues, sortFingerprint: fingerprint });
}
