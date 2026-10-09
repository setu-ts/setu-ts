import type { EntityKey, IDataSource } from '@setu-ts/common';
import { expect } from '@std/expect';

/** Exercises both atomic outcomes and reads every persisted effect from the backend. */
export async function conditionalContract(
  source: IDataSource,
  id: EntityKey,
  missing: EntityKey,
  row: Record<string, unknown>,
  predicate: Record<string, string | number>,
  patch: Record<string, unknown>,
): Promise<void> {
  await source.create(row);
  const before = await source.findById(id);
  const mismatch = Object.fromEntries(
    Object.entries(predicate).map(([key]) => [key, 'never-matches']),
  );
  expect(await source.updateWhere!(id, mismatch, patch)).toBeNull();
  expect(await source.deleteWhere!(id, mismatch)).toBe(false);
  expect(await source.updateWhere!(missing, predicate, patch)).toBeNull();
  expect(await source.deleteWhere!(missing, predicate)).toBe(false);
  expect(await source.findById(id)).toEqual(before);
  expect(await source.findById(missing)).toBeNull();
  expect(await source.updateWhere!(id, predicate, patch)).toMatchObject(patch);
  expect(await source.findById(id)).toMatchObject(patch);
  expect(await source.deleteWhere!(id, predicate)).toBe(true);
  expect(await source.findById(id)).toBeNull();
}
