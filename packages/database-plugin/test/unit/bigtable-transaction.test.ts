/**
 * The single-row deferred-write transaction.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAdapterTransaction, IDataSource } from '@setu-ts/common';
import { resolveBigtableTarget } from '../../src/adapters/bigtable/bigtable-mapping.ts';
import { createBigtableDataSource } from '../../src/adapters/bigtable/bigtable-data-source.ts';
import { BigtableTransaction } from '../../src/adapters/bigtable/bigtable-transaction.ts';
import { BigtableTransactionScopeError } from '../../src/errors.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';
import type { BigtableEntityMapping } from '../../src/adapters/bigtable/bigtable-mapping.ts';

/**
 * Builds a store, a transaction over it, and a NON-transactional data source
 * over the same client.
 *
 * The committed reader is what lets each case read its write back through the
 * `IDataSource` abstraction rather than only through the fake's internal
 * `snapshot()`: a store assertion proves the cells landed, and only a read
 * proves the entity is retrievable through the surface an application uses.
 */
function setup(
  mapping?: Readonly<Record<string, BigtableEntityMapping>>,
): {
  store: FakeBigtableStore;
  tx: BigtableTransaction;
  committed: (entity?: string) => IDataSource;
} {
  const store = new FakeBigtableStore();
  const client = createFakeBigtableClient(store);
  const instance = client.instance('i');
  const resolve = (entity: string): ReturnType<typeof resolveBigtableTarget> =>
    resolveBigtableTarget(entity, mapping);
  const tx = new BigtableTransaction(
    instance,
    resolve,
    (table, target, buffer) => createBigtableDataSource(table, target, { buffer }),
  );
  const committed = (entity = 'User'): IDataSource => {
    const target = resolve(entity);
    return createBigtableDataSource(instance.table(target.table), target);
  };
  return { store, tx, committed };
}

describe('BigtableTransaction', () => {
  it('buffers a create and lands it only at commit', async () => {
    const { store, tx, committed } = setup();
    const users = tx.createDataSource('User');
    const created = await users.create({ id: 'u1', name: 'ada' });
    expect(created).toEqual({ id: 'u1', name: 'ada' });
    expect(store.snapshot('User', 'u1')).toBeUndefined();
    await tx.commit();
    expect(store.snapshot('User', 'u1')).toEqual({ cf: { id: 's:u1', name: 's:ada' } });
    expect(await committed().findById('u1')).toEqual({ id: 'u1', name: 'ada' });
  });

  it('refuses a buffered create whose row turns out to exist', async () => {
    const { store, tx } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1' } });
    await tx.createDataSource('User').create({ id: 'u1', name: 'ada' });
    await expect(tx.commit()).rejects.toThrow(/already exists/);
  });

  it('merges several buffered writes to one row into a single mutation', async () => {
    const { store, tx, committed } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1', name: 's:ada' } });
    const users = tx.createDataSource('User');
    await users.update('u1', { name: 'bob' });
    await users.update('u1', { age: 40 });
    await tx.commit();
    expect(store.snapshot('User', 'u1')).toEqual({
      cf: { id: 's:u1', name: 's:bob', age: 'n:40' },
    });
    expect(await committed().findById('u1')).toEqual({ id: 'u1', name: 'bob', age: 40 });
  });

  it('commits delete-then-write as ONE ordered atomic list', async () => {
    const { store, tx, committed } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1', name: 's:ada', stale: 's:yes' } });
    const users = tx.createDataSource('User');
    expect(await users.delete('u1')).toBe(true);
    await users.create({ id: 'u1', name: 'bob' });
    await tx.commit();
    // The delete ran first, so the qualifier the insert did not name is gone.
    expect(store.snapshot('User', 'u1')).toEqual({ cf: { id: 's:u1', name: 's:bob' } });
    expect(await committed().findById('u1')).toEqual({ id: 'u1', name: 'bob' });
  });

  it('refuses a buffered update whose row is deleted before commit', async () => {
    // The commit used to apply its mutations on BOTH branches, so `onNoMatch`
    // RECREATED the row — a transaction-scoped update degraded to an upsert
    // exactly where the non-transactional path refuses, and the recreated row
    // carried only the updated cells.
    const { store, tx, committed } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1', name: 's:ada' } });
    await tx.createDataSource('User').update('u1', { name: 'bob' });
    store.rows('User').delete('u1');
    await expect(tx.commit()).rejects.toThrow(/no longer exists/);
    expect(store.snapshot('User', 'u1')).toBeUndefined();
    expect(await committed().findById('u1')).toBe(null);
  });

  it('refuses a create buffered after an update of the same row', async () => {
    // The precondition used to come from the FIRST operation alone, so a
    // create after an update kept `requiresAbsent: false` and committed as an
    // upsert instead of refusing the duplicate.
    const { store, tx } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1', name: 's:ada' } });
    const users = tx.createDataSource('User');
    await users.update('u1', { name: 'bob' });
    await expect(users.create({ id: 'u1', name: 'created' }))
      .rejects.toThrow(BigtableTransactionScopeError);
    // Nothing landed: the refusal happened at the write, before any commit.
    expect(store.snapshot('User', 'u1')).toEqual({ cf: { id: 's:u1', name: 's:ada' } });
  });

  it('allows a create after a DELETE of the same row — the replace case', async () => {
    const { store, tx, committed } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1', name: 's:ada' } });
    const users = tx.createDataSource('User');
    await users.delete('u1');
    await users.create({ id: 'u1', name: 'fresh' });
    await tx.commit();
    expect(await committed().findById('u1')).toEqual({ id: 'u1', name: 'fresh' });
    expect(store.snapshot('User', 'u1')).toEqual({ cf: { id: 's:u1', name: 's:fresh' } });
  });

  it('applies a delete-first buffer whatever the row turns out to be', async () => {
    // A delete already reported its own boolean from committed state, so it
    // imposes no precondition and refuses nothing at commit.
    const { tx, committed } = setup();
    const users = tx.createDataSource('User');
    expect(await users.delete('u1')).toBe(false);
    await users.create({ id: 'u1', name: 'fresh' });
    await tx.commit();
    expect(await committed().findById('u1')).toEqual({ id: 'u1', name: 'fresh' });
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

  it('reports the same row a direct update would, for an undefined payload field', async () => {
    // The buffered arm spread `data` wholesale, so a field passed as
    // `undefined` — which `buildCells` deliberately writes no cell for —
    // SHADOWED the stored value in the returned row, while the direct arm
    // (which re-reads) answered the stored value. Two entry points disagreeing
    // about one call.
    const { store, tx, committed } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1', name: 's:ada', age: 'n:36' } });
    const buffered = await tx.createDataSource('User').update('u1', {
      name: undefined,
      age: 37,
    });
    expect(buffered).toEqual({ id: 'u1', name: 'ada', age: 37 });
    await tx.commit();
    expect(await committed().findById('u1')).toEqual({ id: 'u1', name: 'ada', age: 37 });
  });

  it('refuses an update of an absent row at the write, not at commit', async () => {
    const { tx } = setup();
    await expect(tx.createDataSource('User').update('nope', { a: 1 }))
      .rejects.toThrow(/no row keyed 'nope'/);
  });

  it('reports a buffered delete against committed state', async () => {
    const { store, tx, committed } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1' } });
    const users = tx.createDataSource('User');
    expect(await users.delete('u1')).toBe(true);
    // Still present until commit — reads observe committed state only.
    expect(store.snapshot('User', 'u1')).toBeDefined();
    await tx.commit();
    expect(store.snapshot('User', 'u1')).toBeUndefined();
    expect(await committed().findById('u1')).toBe(null);
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
