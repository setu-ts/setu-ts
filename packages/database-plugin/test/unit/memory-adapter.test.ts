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
import { DuplicateKeyError, httpStatusHintOf } from '@setu-ts/common';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { IAdapterTransaction } from '@setu-ts/common';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { UnsupportedQueryFeatureError, UnsupportedRawQueryError } from '../../src/errors.ts';

describe('MemoryAdapter', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe('rawQuery', () => {
    it('rejects with UnsupportedRawQueryError', async () => {
      await expect(adapter.rawQuery('SELECT 1')).rejects.toBeInstanceOf(UnsupportedRawQueryError);
    });
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

    it('overlay findAll and count honor a portable filter', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice', role: 'admin' });
      await adapter.insertEntity('User', { id: '2', name: 'Bob', role: 'user' });
      const txn = await adapter.beginTransaction();
      const ds: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      const matched = await ds.findAll({
        where: {},
        filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'li' },
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(matched.map((r) => r.name)).toEqual(['Alice']);
      expect(
        await ds.count({}, {
          type: 'comparison',
          field: 'name',
          operator: 'contains',
          value: 'li',
        }),
      ).toBe(1);
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
      await ds.create({ id: '2', name: 'Bob' });

      // Mint a cursor under one sort. Two rows against a one-row page make the
      // first page non-terminal, so a REAL token is minted — presenting an
      // empty string here would hit the malformed branch, not this one.
      const first = await ds.findPage!({
        where: {},
        orderBy: { name: 'asc' },
        limit: 1,
        offset: 0,
        select: [],
      });
      expect(first.nextCursor).not.toBeNull();
      // ... then present it under a DIFFERENT sort.
      await expect(
        ds.findPage!({
          where: {},
          orderBy: { name: 'desc' },
          limit: 1,
          offset: 0,
          select: [],
          cursor: first.nextCursor ?? '',
        }),
      ).rejects.toThrow(UnsupportedQueryFeatureError);
    });

    it('conjoins the caller filter with the keyset predicate while walking', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: '1', name: 'Alice', role: 'admin' });
      await ds.create({ id: '2', name: 'Bob', role: 'user' });
      await ds.create({ id: '3', name: 'Carol', role: 'admin' });

      // Page one with the filter applied; its cursor continues the walk with
      // the SAME filter conjoined beside the keyset predicate.
      const p1 = await ds.findPage!({
        where: {},
        filter: { type: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
        orderBy: { name: 'asc' },
        limit: 1,
        offset: 0,
        select: [],
      });
      expect(p1.rows.map((r) => r.name)).toEqual(['Alice']);
      expect(p1.nextCursor).not.toBeNull();

      const p2 = await ds.findPage!({
        where: {},
        filter: { type: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
        orderBy: { name: 'asc' },
        limit: 1,
        offset: 0,
        select: [],
        cursor: p1.nextCursor!,
      });
      expect(p2.rows.map((r) => r.name)).toEqual(['Carol']);
      expect(p2.nextCursor).toBeNull();
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

  describe('primary-key uniqueness (M101c security audit F1)', () => {
    const ALL = { where: {}, orderBy: {}, limit: -1, offset: 0, select: [] } as const;
    it('refuses a create whose caller-supplied key is already stored, without echoing it', async () => {
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'canary-key-7', name: 'first' });
      await expect(ds.create({ id: 'canary-key-7', name: 'second' })).rejects.toThrow(
        /already has a row with this primary key/,
      );
      const refusal = await ds.create({ id: 'canary-key-7' }).catch((error: Error) => error);
      expect((refusal as Error).message).not.toContain('canary-key-7');
      expect(refusal).toBeInstanceOf(DuplicateKeyError);
      expect((refusal as DuplicateKeyError).entity).toBe('User');
      expect(httpStatusHintOf(refusal)?.status).toBe(409);
      // The first row is untouched and still addressable.
      expect(await ds.findById('canary-key-7')).toMatchObject({ name: 'first' });
      expect(await ds.findAll(ALL)).toHaveLength(1);
    });

    it('refuses a duplicate composite key and accepts a distinct one', async () => {
      const ds = adapter.createDataSource('Enrollment', ['courseId', 'personId']);
      await ds.create({ courseId: 'c1', personId: 'p1' });
      await expect(ds.create({ courseId: 'c1', personId: 'p1' })).rejects.toThrow(/primary key/);
      await ds.create({ courseId: 'c1', personId: 'p2' });
      expect(await ds.findAll(ALL)).toHaveLength(2);
    });

    it('generated keys never collide (no scan needed)', async () => {
      const ds = adapter.createDataSource('User');
      await ds.create({ name: 'a' });
      await ds.create({ name: 'b' });
      expect(await ds.findAll(ALL)).toHaveLength(2);
    });

    it('refuses a commit whose buffered create collides with a row committed since', async () => {
      await adapter.connect();
      const all = () => adapter.createDataSource('User').findAll(ALL);
      // Two overlapping transactions buffering the same key.
      const t1 = await adapter.beginTransaction();
      const t2 = await adapter.beginTransaction();
      await (t1 as IAdapterTransaction).createDataSource('User').create({ id: 'X', by: 't1' });
      await (t2 as IAdapterTransaction).createDataSource('User').create({ id: 'X', by: 't2' });
      await t1.commit();
      await expect(t2.commit()).rejects.toThrow(/primary key/);
      expect(await all()).toEqual([{ id: 'X', by: 't1' }]);
      // A transaction overlapping a direct create of the same key.
      const t3 = await adapter.beginTransaction();
      await (t3 as IAdapterTransaction).createDataSource('User').create({ id: 'Y', by: 't3' });
      await adapter.createDataSource('User').create({ id: 'Y', by: 'direct' });
      await expect(t3.commit()).rejects.toThrow(/primary key/);
      expect((await all()).filter((r) => r.id === 'Y')).toEqual([{ id: 'Y', by: 'direct' }]);
    });

    it('refuses an update that changes the primary key, direct and in a transaction', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'own', v: 1 });
      await ds.create({ id: 'victim', v: 2 });
      await expect(ds.update('own', { id: 'victim' })).rejects.toThrow(
        /cannot change the primary key/,
      );
      expect(await ds.update('own', { id: 'own', v: 3 })).toMatchObject({ id: 'own', v: 3 });
      const txn = await adapter.beginTransaction();
      const tds = (txn as IAdapterTransaction).createDataSource('User');
      await expect(tds.update('own', { id: 'victim' })).rejects.toThrow(/primary key/);
      await txn.rollback();
      expect((await ds.findAll(ALL)).map((r) => r.id).sort()).toEqual(['own', 'victim']);
    });

    it('one transaction cannot commit a duplicate through delete-then-recreate (R3-F1)', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      // C1: a stored K, deleted then created twice.
      await ds.create({ id: 'K', v: 0 });
      const t1 = await adapter.beginTransaction();
      const d1 = (t1 as IAdapterTransaction).createDataSource('User');
      await d1.delete('K');
      await d1.create({ id: 'K', v: 1 });
      await expect(d1.create({ id: 'K', v: 2 })).rejects.toThrow(/primary key/);
      await t1.commit();
      expect((await ds.findAll(ALL)).filter((r) => r.id === 'K')).toEqual([{ id: 'K', v: 1 }]);
      // C2: nothing stored; create, delete, create, create.
      const t2 = await adapter.beginTransaction();
      const d2 = (t2 as IAdapterTransaction).createDataSource('User');
      await d2.create({ id: 'J', v: 1 });
      await d2.delete('J');
      await d2.create({ id: 'J', v: 2 });
      await expect(d2.create({ id: 'J', v: 3 })).rejects.toThrow(/primary key/);
      await t2.commit();
      expect((await ds.findAll(ALL)).filter((r) => r.id === 'J')).toEqual([{ id: 'J', v: 2 }]);
    });

    it('a row created then updated in a transaction commits updated', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'S', v: 0 });
      const txn = await adapter.beginTransaction();
      const tds = (txn as IAdapterTransaction).createDataSource('User');
      await tds.update('S', { v: 9 }); // shadow on a stored row, then
      await tds.delete('S'); // delete it (the shadow must not resurface)
      await tds.create({ id: 'S', v: 1 });
      await tds.update('S', { v: 2 }); // updates the buffered row in place
      expect(await tds.findById('S')).toEqual({ id: 'S', v: 2 });
      await txn.commit();
      expect((await ds.findAll(ALL)).filter((r) => r.id === 'S')).toEqual([{ id: 'S', v: 2 }]);
    });

    it('allows a commit that deletes a stored row and recreates its key', async () => {
      await adapter.connect();
      await adapter.createDataSource('User').create({ id: 'Z', v: 1 });
      const txn = await adapter.beginTransaction();
      const ds = (txn as IAdapterTransaction).createDataSource('User');
      await ds.delete('Z');
      await ds.create({ id: 'Z', v: 2 });
      await txn.commit();
      expect(await adapter.createDataSource('User').findAll(ALL)).toEqual([{ id: 'Z', v: 2 }]);
    });

    it('refuses a duplicate inside a transaction, against committed and buffered rows', async () => {
      await adapter.connect();
      await adapter.createDataSource('User').create({ id: 'u1', name: 'committed' });
      const txn = await adapter.beginTransaction();
      const ds = (txn as IAdapterTransaction).createDataSource('User');
      await expect(ds.create({ id: 'u1' })).rejects.toThrow(/primary key/);
      await ds.create({ id: 'u2' });
      await expect(ds.create({ id: 'u2' })).rejects.toThrow(/primary key/);
      await txn.rollback();
    });
  });
});
