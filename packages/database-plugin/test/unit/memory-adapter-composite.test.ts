/**
 * Unit tests for MemoryAdapter — composite keys (T2).
 *
 * Tests cover:
 * - composite store matching (findById/update/delete on a two-column key)
 * - overlay semantics with a composite key (update shadow, delete tombstone, commit/rollback)
 * - scalar store is byte-identical to pre-T2 behavior (pinned regression cases)
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { IAdapterTransaction } from '@setu-ts/common';
import type { DataSource } from '../../src/repositories/base-repository.ts';

describe('MemoryAdapter — composite keys', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe('composite store matching', () => {
    it('findEntityById matches on every named column', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
      await ds.create({ tenantId: 't1', userId: 'u2', name: 'Bob' });
      await ds.create({ tenantId: 't2', userId: 'u1', name: 'Carol' });

      const found = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(found?.name).toBe('Alice');

      const missing = await ds.findById({ tenantId: 't2', userId: 'u2' });
      expect(missing).toBeNull();
    });

    it('findEntityById is order-independent for composite keys', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      // Record literal property order differs but should match the same row.
      const found = await ds.findById({ userId: 'u1', tenantId: 't1' });
      expect(found?.name).toBe('Alice');
    });

    it('updateEntity merges on composite key', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice', active: true });

      const updated = await ds.update({ tenantId: 't1', userId: 'u1' }, { name: 'Alicia' });
      expect(updated.name).toBe('Alicia');
      expect(updated.active).toBe(true);

      const found = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(found?.name).toBe('Alicia');
    });

    it('updateEntity rejects when composite row is absent', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      await expect(
        ds.update({ tenantId: 't2', userId: 'u9' }, { name: 'X' }),
      ).rejects.toThrow('not found');
    });

    it('deleteEntity removes on composite key', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
      await ds.create({ tenantId: 't1', userId: 'u2', name: 'Bob' });

      const deleted = await ds.delete({ tenantId: 't1', userId: 'u1' });
      expect(deleted).toBe(true);

      const remaining = await ds.findAll({
        where: {},
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(remaining.length).toBe(1);
      expect(remaining[0].name).toBe('Bob');
    });

    it('deleteEntity returns false when composite row is absent', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      const deleted = await ds.delete({ tenantId: 't2', userId: 'u9' });
      expect(deleted).toBe(false);
    });
  });

  describe('overlay semantics with composite key', () => {
    it('update shadow in tx is visible inside tx and restored after rollback', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      await txDs.update({ tenantId: 't1', userId: 'u1' }, { name: 'Updated' });

      const inside = await txDs.findById({ tenantId: 't1', userId: 'u1' });
      expect(inside?.name).toBe('Updated');

      await txn.rollback();
      const outside = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(outside?.name).toBe('Alice');
    });

    it('delete tombstone in tx is invisible after rollback', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      await txDs.delete({ tenantId: 't1', userId: 'u1' });

      const inside = await txDs.findById({ tenantId: 't1', userId: 'u1' });
      expect(inside).toBeNull();

      await txn.rollback();
      const outside = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(outside?.name).toBe('Alice');
    });

    it('commit flushes a composite tombstone and removes the committed row', async () => {
      // The commit path re-parses each composite tombstone key back into its
      // named columns (string and numeric values take different parse arms).
      await adapter.connect();
      const ds = adapter.createDataSource('Item', ['tenantId', 'position']);
      await ds.create({ tenantId: 't1', position: 7, name: 'Keep' });
      await ds.create({ tenantId: 't1', position: 8, name: 'Drop' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('Item');
      await txDs.delete({ tenantId: 't1', position: 8 });
      await txn.commit();

      const remaining = await ds.findAll({
        where: {},
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(remaining.map((r) => r.name)).toEqual(['Keep']);
    });

    it('commit applies composite overlay to committed store', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      await txDs.update({ tenantId: 't1', userId: 'u1' }, { name: 'Committed' });
      await txn.commit();

      const outside = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(outside?.name).toBe('Committed');
    });

    it('overlay findAll honors a where filter on composite key', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice', role: 'admin' });
      await ds.create({ tenantId: 't1', userId: 'u2', name: 'Bob', role: 'user' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      const admins = await txDs.findAll({
        where: { role: 'admin' },
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(admins.map((r) => r.name)).toEqual(['Alice']);
      await txn.rollback();
    });
  });

  describe('scalar store — regression cases', () => {
    it('findEntityById with scalar key is unchanged', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const found = await adapter.findEntityById('User', '1');
      expect(found?.name).toBe('Alice');
      const missing = await adapter.findEntityById('User', '999');
      expect(missing).toBeNull();
    });

    it('updateEntity with scalar key is unchanged', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const updated = await adapter.updateEntity('User', '1', { name: 'Bob' });
      expect(updated.name).toBe('Bob');
    });

    it('deleteEntity with scalar key is unchanged', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      expect(await adapter.deleteEntity('User', '1')).toBe(true);
      expect(await adapter.deleteEntity('User', '1')).toBe(false);
    });

    it('createDataSource defaults primaryKey to ["id"]', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: '1', name: 'Alice' });
      const found = await ds.findById('1');
      expect(found?.name).toBe('Alice');
    });

    it('getStore with string primaryKey creates a scalar store', async () => {
      await adapter.connect();
      const store = adapter.getStore('User', 'id');
      expect(store.primaryKey).toEqual(['id']);
    });

    it('getStore with array primaryKey creates a composite store', async () => {
      await adapter.connect();
      const store = adapter.getStore('User', ['tenantId', 'userId']);
      expect(store.primaryKey).toEqual(['tenantId', 'userId']);
    });
  });

  describe('overlayKey composition', () => {
    it('produces the same key regardless of record property order', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['a', 'b']);
      await ds.create({ a: 'x', b: 'y', v: 1 });

      // Both orders should find the same row.
      const found1 = await ds.findById({ a: 'x', b: 'y' });
      const found2 = await ds.findById({ b: 'y', a: 'x' });
      expect(found1).not.toBeNull();
      expect(found2).not.toBeNull();
      expect(found1).toEqual(found2);
    });
  });
});

describe('transaction overlay preserves key identity (CodeRabbit #3896481569)', () => {
  /**
   * The tombstone commit path used to reconstruct the key from the overlay's
   * own map key, coercing any numeric-looking segment with `Number()`. A
   * STRING key such as '42' came back as the number 42, matched no record, and
   * the delete silently survived commit — the row was still there.
   */
  it('commits a delete for a numeric-LOOKING string key', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const source = adapter.createDataSource('Doc');
    await source.create({ id: '42', title: 'forty-two' });
    await source.create({ id: '0042', title: 'padded' });

    const tx = await adapter.beginTransaction();
    expect(await tx.createDataSource('Doc').delete('42')).toBe(true);
    await tx.commit();

    expect(await source.findById('42')).toBeNull();
    // The padded sibling is untouched: '0042' and '42' are different keys, and
    // numeric coercion would have collapsed them.
    expect(await source.findById('0042')).not.toBeNull();
  });

  it('commits a delete for a composite key whose values contain the delimiters', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const source = adapter.createDataSource('Pair', ['a', 'b']);
    await source.create({ a: 'x=1|y', b: '2', v: 'first' });
    await source.create({ a: 'x', b: '1|y=2', v: 'second' });

    const tx = await adapter.beginTransaction();
    expect(await tx.createDataSource('Pair').delete({ a: 'x=1|y', b: '2' })).toBe(true);
    await tx.commit();

    expect(await source.findById({ a: 'x=1|y', b: '2' })).toBeNull();
    expect(await source.findById({ a: 'x', b: '1|y=2' })).not.toBeNull();
  });
});
