/**
 * The single-row deferred-write transaction.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAdapterTransaction } from '@setu-ts/common';
import { resolveBigtableTarget } from '../../src/adapters/bigtable/bigtable-mapping.ts';
import { createBigtableDataSource } from '../../src/adapters/bigtable/bigtable-data-source.ts';
import { BigtableTransaction } from '../../src/adapters/bigtable/bigtable-transaction.ts';
import { BigtableTransactionScopeError } from '../../src/errors.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';
import type { BigtableEntityMapping } from '../../src/adapters/bigtable/bigtable-mapping.ts';

/** Builds a store plus a transaction over it. */
function setup(
  mapping?: Readonly<Record<string, BigtableEntityMapping>>,
): { store: FakeBigtableStore; tx: BigtableTransaction } {
  const store = new FakeBigtableStore();
  const client = createFakeBigtableClient(store);
  const instance = client.instance('i');
  const tx = new BigtableTransaction(
    instance,
    (entity) => resolveBigtableTarget(entity, mapping),
    (table, target, buffer) => createBigtableDataSource(table, target, { buffer }),
  );
  return { store, tx };
}

describe('BigtableTransaction', () => {
  it('buffers a create and lands it only at commit', async () => {
    const { store, tx } = setup();
    const users = tx.createDataSource('User');
    const created = await users.create({ id: 'u1', name: 'ada' });
    expect(created).toEqual({ id: 'u1', name: 'ada' });
    expect(store.snapshot('User', 'u1')).toBeUndefined();
    await tx.commit();
    expect(store.snapshot('User', 'u1')).toEqual({ cf: { id: 's:u1', name: 's:ada' } });
  });

  it('refuses a buffered create whose row turns out to exist', async () => {
    const { store, tx } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1' } });
    await tx.createDataSource('User').create({ id: 'u1', name: 'ada' });
    await expect(tx.commit()).rejects.toThrow(/already exists/);
  });

  it('merges several buffered writes to one row into a single mutation', async () => {
    const { store, tx } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1', name: 's:ada' } });
    const users = tx.createDataSource('User');
    await users.update('u1', { name: 'bob' });
    await users.update('u1', { age: 40 });
    await tx.commit();
    expect(store.snapshot('User', 'u1')).toEqual({
      cf: { id: 's:u1', name: 's:bob', age: 'n:40' },
    });
  });

  it('commits delete-then-write as ONE ordered atomic list', async () => {
    const { store, tx } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1', name: 's:ada', stale: 's:yes' } });
    const users = tx.createDataSource('User');
    expect(await users.delete('u1')).toBe(true);
    await users.create({ id: 'u1', name: 'bob' });
    await tx.commit();
    // The delete ran first, so the qualifier the insert did not name is gone.
    expect(store.snapshot('User', 'u1')).toEqual({ cf: { id: 's:u1', name: 's:bob' } });
  });

  it('refuses a second row key at the write that crosses the bound', async () => {
    const { tx } = setup();
    const users = tx.createDataSource('User');
    await users.create({ id: 'u1' });
    await expect(users.create({ id: 'u2' })).rejects.toThrow(BigtableTransactionScopeError);
  });

  it('refuses a second TABLE even at the same row key', async () => {
    const { tx } = setup({ Order: { table: 'orders' } });
    await tx.createDataSource('User').create({ id: 'k' });
    await expect(tx.createDataSource('Order').create({ id: 'k' }))
      .rejects.toThrow(/already targets 'User'\/'k'/);
  });

  it('refuses an update of an absent row at the write, not at commit', async () => {
    const { tx } = setup();
    await expect(tx.createDataSource('User').update('nope', { a: 1 }))
      .rejects.toThrow(/no row keyed 'nope'/);
  });

  it('reports a buffered delete against committed state', async () => {
    const { store, tx } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1' } });
    const users = tx.createDataSource('User');
    expect(await users.delete('u1')).toBe(true);
    // Still present until commit — reads observe committed state only.
    expect(store.snapshot('User', 'u1')).toBeDefined();
    await tx.commit();
    expect(store.snapshot('User', 'u1')).toBeUndefined();
  });

  it('reports false for a buffered delete of an absent row', async () => {
    const { tx } = setup();
    expect(await tx.createDataSource('User').delete('nope')).toBe(false);
  });

  it('discards the buffer on rollback and sends nothing', async () => {
    const { store, tx } = setup();
    await tx.createDataSource('User').create({ id: 'u1' });
    await tx.rollback();
    expect(store.snapshot('User', 'u1')).toBeUndefined();
    // Idempotent, unlike commit: the framework rolls back inside the same catch
    // that saw a failed commit.
    await tx.rollback();
  });

  it('refuses a write after the transaction settled', async () => {
    const { tx } = setup();
    const users = tx.createDataSource('User');
    await tx.commit();
    await expect(users.create({ id: 'u1' })).rejects.toThrow(/already settled/);
  });

  it('refuses a second commit', async () => {
    const { tx } = setup();
    await tx.commit();
    await expect(tx.commit()).rejects.toThrow(/already settled/);
  });

  it('commits nothing when no write was buffered', async () => {
    const { store, tx } = setup();
    tx.createDataSource('User');
    await tx.commit();
    expect(store.tables.get('User')?.size ?? 0).toBe(0);
  });

  it('leaves the row untouched when an update buffers no cell at all', async () => {
    const { store, tx } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1', name: 's:ada' } });
    await tx.createDataSource('User').update('u1', {});
    await tx.commit();
    expect(store.snapshot('User', 'u1')).toEqual({ cf: { id: 's:u1', name: 's:ada' } });
  });

  it('refuses a buffered write before any row is claimed', () => {
    // Unreachable through a data source, which claims first; reachable through
    // the write-buffer seam the transaction publishes to it.
    const { tx } = setup();
    expect(() => tx.insert({ cf: { a: '1' } }, false))
      .toThrow(BigtableTransactionScopeError);
    expect(() => tx.remove()).toThrow(/before any row was claimed/);
  });

  it('sends nothing when the only buffered write carries no cell', async () => {
    const { store, tx } = setup();
    tx.claim('User', 'u1', 'update');
    tx.insert({}, false);
    await tx.commit();
    expect(store.snapshot('User', 'u1')).toBeUndefined();
  });

  it('satisfies IAdapterTransaction structurally', () => {
    const { tx } = setup();
    const handle: IAdapterTransaction = tx;
    expect(typeof handle.createDataSource).toBe('function');
  });
});
