/**
 * Unit tests for MemoryAdapter.
 *
 * Tests cover:
 * - connect/disconnect lifecycle
 * - CRUD operations (insert, find, update, delete, query, count)
 * - per-transaction overlay isolation (creates, update shadows, delete tombstones)
 * - commit applies overlay; rollback discards
 * - update-in-tx isolation — uncommitted update invisible outside
 * - delete-in-tx isolation — uncommitted delete invisible outside
 * - findPage — cursor pagination, including the P11 tied-fixture walk
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { IAdapterTransaction } from '@setu-ts/common';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

describe('MemoryAdapter', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe('connect / disconnect / isReady', () => {
    it('is not ready before connect', () => {
      expect(adapter.isReady()).toBe(false);
    });

    it('is ready after connect', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });

    it('is not ready after disconnect', async () => {
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.isReady()).toBe(false);
    });
  });

  describe('getStore', () => {
    it('creates a store lazily', async () => {
      await adapter.connect();
      const store = adapter.getStore('User');
      expect(store.records).toBeDefined();
    });

    it('returns the same store for the same entity', async () => {
      await adapter.connect();
      const a = adapter.getStore('User');
      const b = adapter.getStore('User');
      expect(a).toBe(b);
    });
  });

  describe('insertEntity', () => {
    it('inserts and returns the entity', async () => {
      await adapter.connect();
      const entity = await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      expect(entity.name).toBe('Alice');
    });

    it('generates an id when absent', async () => {
      await adapter.connect();
      const entity = await adapter.insertEntity('User', { name: 'Alice' });
      expect(entity.id).toBeDefined();
    });
  });

  describe('findEntityById', () => {
    it('returns the entity when found', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const found = await adapter.findEntityById('User', '1');
      expect(found?.name).toBe('Alice');
    });

    it('returns null when not found', async () => {
      await adapter.connect();
      const found = await adapter.findEntityById('User', '999');
      expect(found).toBeNull();
    });
  });

  describe('updateEntity', () => {
    it('updates and returns the entity', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const updated = await adapter.updateEntity('User', '1', { name: 'Bob' });
      expect(updated.name).toBe('Bob');
    });

    it('preserves unchanged fields', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice', email: 'a@b.c' });
      const updated = await adapter.updateEntity('User', '1', { name: 'Bob' });
      expect(updated.email).toBe('a@b.c');
    });

    it('throws when entity not found', async () => {
      await adapter.connect();
      await expect(adapter.updateEntity('User', '999', { name: 'X' })).rejects.toThrow();
    });
  });

  describe('deleteEntity', () => {
    it('returns true when deleted', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const result = await adapter.deleteEntity('User', '1');
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      await adapter.connect();
      const result = await adapter.deleteEntity('User', '999');
      expect(result).toBe(false);
    });
  });

  describe('queryEntities', () => {
    it('returns all entities when no filter', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      await adapter.insertEntity('User', { id: '2', name: 'Bob' });
      const results = await adapter.queryEntities('User', {
        where: {},
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(results.length).toBe(2);
    });

    it('applies a where filter', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice', role: 'admin' });
      await adapter.insertEntity('User', { id: '2', name: 'Bob', role: 'user' });
      const results = await adapter.queryEntities('User', {
        where: { role: 'admin' },
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(results.map((r) => r.name)).toEqual(['Alice']);
    });

    it('conjoins an expression filter with where for reads and counts', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice', role: 'admin', score: 4 });
      await adapter.insertEntity('User', { id: '2', name: 'Alicia', role: 'admin', score: 8 });
      await adapter.insertEntity('User', { id: '3', name: 'Bob', role: 'user', score: 10 });
      const filter = {
        type: 'comparison' as const,
        field: 'score',
        operator: 'gte' as const,
        value: 8,
      };

      const results = await adapter.queryEntities('User', {
        where: { role: 'admin' },
        filter,
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });

      expect(results.map((row) => row.id)).toEqual(['2']);
      expect(await adapter.countEntities('User', { role: 'admin' }, filter)).toBe(1);
    });
  });

  describe('countEntities', () => {
    it('returns total count when no filter', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      await adapter.insertEntity('User', { id: '2', name: 'Bob' });
      const count = await adapter.countEntities('User', {});
      expect(count).toBe(2);
    });

    it('counts only matching entities when a filter is given', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice', role: 'admin' });
      await adapter.insertEntity('User', { id: '2', name: 'Bob', role: 'user' });
      expect(await adapter.countEntities('User', { role: 'admin' })).toBe(1);
    });
  });

  describe('beginTransaction — overlay isolation', () => {
    it('commits successfully', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.commit();
    });

    it('rollbacks successfully', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.rollback();
    });

    it('create in tx visible inside tx', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      const created = await ds.create({ id: 'tx-1', name: 'TxUser' });
      const found = await ds.findById(created.id as string);
      expect(found?.name).toBe('TxUser');
      await txn.commit();
    });

    it('update shadow in tx invisible after rollback', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      await ds.update('1', { name: 'Updated' });
      // Inside tx — updated
      const inside = await ds.findById('1');
      expect(inside?.name).toBe('Updated');
      // Rollback
      await txn.rollback();
      // Outside — original
      const outside = await adapter.findEntityById('User', '1');
      expect(outside?.name).toBe('Alice');
    });

    it('delete tombstone in tx invisible after rollback', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      await ds.delete('1');
      // Inside tx — gone
      const inside = await ds.findById('1');
      expect(inside).toBeNull();
      // Rollback
      await txn.rollback();
      // Outside — still there
      const outside = await adapter.findEntityById('User', '1');
      expect(outside?.name).toBe('Alice');
    });

    it('commit applies overlay to committed store', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      await ds.update('1', { name: 'Committed' });
      await txn.commit();
      // After commit — persisted
      const outside = await adapter.findEntityById('User', '1');
      expect(outside?.name).toBe('Committed');
    });

    it('overlay findAll and count honor a where filter', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice', role: 'admin' });
      await adapter.insertEntity('User', { id: '2', name: 'Bob', role: 'user' });
      const txn = await adapter.beginTransaction();
      const ds: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      const admins = await ds.findAll({
        where: { role: 'admin' },
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(admins.map((r) => r.name)).toEqual(['Alice']);
      expect(await ds.count({ role: 'admin' })).toBe(1);
      await txn.rollback();
    });

    it('overlay update rejects when the row is absent', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const ds: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      await expect(ds.update('missing', { name: 'X' })).rejects.toThrow('not found');
      await txn.rollback();
    });

    it('overlay delete returns false when the row is absent', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const ds: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      expect(await ds.delete('missing')).toBe(false);
      await txn.rollback();
    });
  });

  describe('disconnect clears stores', () => {
    it('clears all data after disconnect', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      await adapter.disconnect();
      const found = await adapter.findEntityById('User', '1');
      expect(found).toBeNull();
    });
  });

  // Retro review (Part 4): `select` is now honored by the DataSource (both the
  // plain and the transaction-overlay one) instead of being re-projected by
  // BaseRepository, which also re-applied `offset` and emptied every page but
  // the first.
  describe('select projection', () => {
    it('projects fields on the plain data source', async () => {
      const adapter = new MemoryAdapter();
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice', secret: 'x' });

      const rows = await adapter.queryEntities('User', {
        where: {},
        orderBy: {},
        limit: -1,
        offset: 0,
        select: ['name'],
      });
      expect(rows).toEqual([{ name: 'Alice' }]);
    });

    it('projects fields on the transaction overlay data source', async () => {
      const adapter = new MemoryAdapter();
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice', secret: 'x' });

      const tx = await adapter.beginTransaction();
      const ds = tx.createDataSource('User');
      await ds.create({ id: '2', name: 'Bob', secret: 'y' });

      const rows = await ds.findAll({
        where: {},
        orderBy: { name: 'asc' },
        limit: -1,
        offset: 0,
        select: ['name'],
      });
      expect(rows).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
      await tx.rollback();
    });
  });

  describe('findPage', () => {
    it('walks a tied-fixture across three pages with no row repeated or skipped', async () => {
      // P11 negative control: deliberate sort-key ties mean a naive predicate
      // (omitting the tiebreaker) would lose rows. The fixture seeds 6 rows
      // with only two distinct `createdAt` values, so the tiebreaker on `id`
      // is load-bearing.
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'a', createdAt: '2024-01-01', name: '1' });
      await ds.create({ id: 'b', createdAt: '2024-01-01', name: '2' });
      await ds.create({ id: 'c', createdAt: '2024-01-01', name: '3' });
      await ds.create({ id: 'd', createdAt: '2024-01-02', name: '4' });
      await ds.create({ id: 'e', createdAt: '2024-01-02', name: '5' });
      await ds.create({ id: 'f', createdAt: '2024-01-02', name: '6' });

      const seenIds = [] as string[];
      let cursor: string | null = null;
      for (let page = 1; page <= 3; page++) {
        const result = await ds.findPage!({
          where: {},
          orderBy: { createdAt: 'asc', id: 'asc' },
          limit: 2,
          offset: 0,
          select: [],
          ...(cursor !== null ? { cursor } : {}),
        });
        if (page < 3) {
          expect(result.nextCursor).not.toBeNull();
          cursor = result.nextCursor;
        } else {
          expect(result.nextCursor).toBeNull();
        }
        for (const row of result.rows) {
          const id = row.id as string;
          expect(seenIds).not.toContain(id);
          seenIds.push(id);
        }
      }
      expect(seenIds.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });

    it('reports nextCursor: null on the last page', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('Item');
      await ds.create({ id: 'x', score: 1 });
      await ds.create({ id: 'y', score: 2 });
      await ds.create({ id: 'z', score: 3 });

      const p1 = await ds.findPage!({
        where: {},
        orderBy: { score: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
      });
      expect(p1.rows.length).toBe(2);
      expect(p1.nextCursor).not.toBeNull();

      const p2 = await ds.findPage!({
        where: {},
        orderBy: { score: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
        cursor: p1.nextCursor!,
      });
      expect(p2.rows.length).toBe(1);
      expect(p2.nextCursor).toBeNull();
    });

    it('rejects by name when the cursor token is malformed', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: '1', name: 'Alice' });

      await expect(
        ds.findPage!({
          where: {},
          orderBy: { name: 'asc' },
          limit: 10,
          offset: 0,
          select: [],
          cursor: 'not-base64!!!',
        }),
      ).rejects.toThrow(UnsupportedQueryFeatureError);
    });

    it('rejects by name when the cursor fingerprint does not match the sort', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: '1', name: 'Alice' });

      // Mint a cursor under one sort ...
      const first = await ds.findPage!({
        where: {},
        orderBy: { name: 'asc' },
        limit: 10,
        offset: 0,
        select: [],
      });
      // ... then present it under a DIFFERENT sort.
      await expect(
        ds.findPage!({
          where: {},
          orderBy: { name: 'desc' },
          limit: 10,
          offset: 0,
          select: [],
          cursor: first.nextCursor ?? '',
        }),
      ).rejects.toThrow(UnsupportedQueryFeatureError);
    });

    it('strips key columns from returned rows when a projection is present', async () => {
      // Plan §8 risk: when a projection is active the key columns must be
      // added to the internal select so they participate in the probe and
      // are available for cursor minting; they must then be stripped from
      // the returned rows so the caller sees only their projection.
      await adapter.connect();
      const ds = adapter.createDataSource('Secret', ['code']);
      await ds.create({ code: 'alpha', value: 1, secret: 'x' });
      await ds.create({ code: 'beta', value: 2, secret: 'y' });
      await ds.create({ code: 'gamma', value: 3, secret: 'z' });

      const result = await ds.findPage!({
        where: {},
        orderBy: { value: 'asc' },
        limit: 2,
        offset: 0,
        select: ['value'],
      });
      expect(result.rows.length).toBe(2);
      expect(result.nextCursor).not.toBeNull();
      // Caller's projection is what comes back — key column is stripped.
      for (const row of result.rows) {
        expect('code' in row).toBe(false);
        expect(row).toHaveProperty('value');
      }

      // Walk the second page using the cursor and confirm the projection
      // still strips the key column.
      const p2 = await ds.findPage!({
        where: {},
        orderBy: { value: 'asc' },
        limit: 2,
        offset: 0,
        select: ['value'],
        cursor: result.nextCursor!,
      });
      expect(p2.rows.length).toBe(1);
      expect(p2.nextCursor).toBeNull();
      for (const row of p2.rows) {
        expect('code' in row).toBe(false);
        expect(row).toHaveProperty('value');
      }
    });

    it('honors findPage on the transaction overlay', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('TxItem');
      await ds.create({ id: '1', score: 10 });
      await ds.create({ id: '2', score: 20 });
      await ds.create({ id: '3', score: 30 });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('TxItem');
      await txDs.create({ id: '4', score: 40 }); // buffered, visible inside tx

      const p1 = await txDs.findPage!({
        where: {},
        orderBy: { score: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
      });
      expect(p1.rows.map((r) => r.score)).toEqual([10, 20]);
      expect(p1.nextCursor).not.toBeNull();

      await txn.rollback();
      // After rollback — the buffered create is gone.
      const afterRollback = await ds.findAll({
        where: {},
        orderBy: { score: 'asc' },
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(afterRollback.length).toBe(3);
    });
  });
});
