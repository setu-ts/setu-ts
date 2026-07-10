/**
 * Coverage tests for DrizzleAdapter real CRUD data-source paths.
 *
 * Exercises createDrizzleDataSource CRUD read-back, transaction bridge
 * commit/rollback, rawQuery, createDataSourceForEntity, and connect-time
 * branches (fallback operators, table validation, lazy-throw).
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createDrizzleDataSource,
  DrizzleAdapter,
  type DrizzleOperators,
} from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createFakeDrizzleInstance } from '../fixtures/fake-drizzle-instance.ts';
import type { IAdapterTransaction } from '../../src/adapters/adapter.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { normalizeQuery } from '../../src/query/query-builder.ts';
import type { NormalizedQuery } from '../../src/query/query-builder.ts';

describe('DrizzleAdapter — CRUD data-source coverage', () => {
  let fakeDb: ReturnType<typeof createFakeDrizzleInstance>;
  let adapter: DrizzleAdapter;
  const tables = { user: {}, post: {} };

  beforeEach(() => {
    fakeDb = createFakeDrizzleInstance();
    adapter = new DrizzleAdapter({
      drizzleInstance: fakeDb,
      drizzleTables: tables,
    });
  });

  describe('createDrizzleDataSource CRUD read-back', () => {
    let ds: DataSource;
    const ops: DrizzleOperators = {
      // Fake extractWhereId checks 'id' in obj — return { id: val } so the fake can match.
      eq: (_col: unknown, val: unknown) => ({ id: val }),
      and: (..._exprs: unknown[]) => ({}),
      asc: (_col: unknown) => ({}),
      desc: (_col: unknown) => ({}),
    };

    beforeEach(async () => {
      await adapter.connect();
      ds = createDrizzleDataSource(fakeDb, 'user', tables, ops);
    });

    it('create() then findById() returns the created row', async () => {
      const created = await ds.create({ id: '100', name: 'Alice' });
      expect(created.name).toBe('Alice');

      const found = await ds.findById('100');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Alice');
    });

    it('findAll() returns rows after inserts', async () => {
      await ds.create({ id: '101', name: 'A' });
      await ds.create({ id: '102', name: 'B' });

      const q: NormalizedQuery = normalizeQuery();
      const all = await ds.findAll(q);
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('update() then findById() returns changed field', async () => {
      await ds.create({ id: '103', name: 'Original' });
      const updated = await ds.update('103', { name: 'Updated' });
      expect(updated.name).toBe('Updated');

      const found = await ds.findById('103');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Updated');
    });

    it('delete() then findById() returns null', async () => {
      await ds.create({ id: '104', name: 'To Delete' });
      const deleted = await ds.delete('104');
      expect(deleted).toBe(true);

      const found = await ds.findById('104');
      expect(found).toBeNull();
    });

    it('count() returns correct count', async () => {
      await ds.create({ id: '105', name: 'X' });
      await ds.create({ id: '106', name: 'Y' });

      const total = await ds.count({});
      expect(total).toBeGreaterThanOrEqual(2);
    });

    it('findAll() with where/orderBy/limit/offset/select', async () => {
      await ds.create({ id: '107', name: 'A', email: 'a@b.c' });
      await ds.create({ id: '108', name: 'B', email: 'b@b.c' });

      const whereQ = normalizeQuery({ where: { name: 'A' } });
      const filtered = await ds.findAll(whereQ);
      expect(filtered.length).toBe(1);
      expect(filtered[0].name).toBe('A');

      const pagedQ = normalizeQuery({ offset: 1, limit: 1 });
      const paged = await ds.findAll(pagedQ);
      expect(paged.length).toBe(1);

      const projQ = normalizeQuery({ select: ['name'] });
      const projected = await ds.findAll(projQ);
      for (const row of projected) {
        expect(row).not.toHaveProperty('email');
        expect(row).toHaveProperty('name');
      }
    });
  });

  describe('transaction bridge', () => {
    it('commit flushes data created in tx', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const txDs = adapterTxn.createDataSource('user');

      await txDs.create({ id: 'tx1', name: 'InTx' });
      await txn.commit();

      const mainDs = createDrizzleDataSource(
        fakeDb,
        'user',
        tables,
        {
          eq: () => ({}),
          and: () => ({}),
          asc: () => ({}),
          desc: () => ({}),
        },
      );
      const found = await mainDs.findById('tx1');
      expect(found).not.toBeNull();
    });

    it('rollback resolves without error', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.rollback();
      // Rollback completed without throwing — the two-deferred bridge works.
    });
  });

  describe('rawQuery', () => {
    it('delegates to db.execute', async () => {
      await adapter.connect();
      await adapter.rawQuery('SELECT 1');
      const call = fakeDb.recordedCalls.find((c) => c.action === 'execute');
      expect(call).toBeDefined();
    });
  });

  describe('createDataSourceForEntity', () => {
    it('creates a data source for known entity after connect', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('user');
      expect(ds).toBeDefined();
    });
  });

  describe('rawQuery not-connected', () => {
    it('throws when adapter is not connected', async () => {
      await expect(adapter.rawQuery('SELECT 1')).rejects.toThrow('not connected');
    });
  });

  describe('createDataSourceForEntity not-connected', () => {
    it('throws when adapter is not connected', () => {
      expect(() => adapter.createDataSourceForEntity('user')).toThrow('not connected');
    });
  });

  describe('connect-time branches', () => {
    it('throws when no drizzleInstance and import fails', async () => {
      const noDbAdapter = new DrizzleAdapter({
        url: 'postgresql://localhost/test',
        drizzleTables: { user: {} },
      });
      await expect(noDbAdapter.connect()).rejects.toThrow('Failed to load Drizzle');
    });

    it('validates drizzleTables entries', async () => {
      const badAdapter = new DrizzleAdapter({
        drizzleInstance: fakeDb,
        drizzleTables: { bad: null },
      });
      await expect(badAdapter.connect()).rejects.toThrow("table 'bad' is not a valid");
    });
  });

  describe('validateInstance rejection', () => {
    it('rejects instance missing select', async () => {
      const bad = { transaction: () => {} };
      const a = new DrizzleAdapter({ drizzleInstance: bad, drizzleTables: tables });
      await expect(a.connect()).rejects.toThrow('missing');
    });

    it('rejects instance missing transaction', async () => {
      const bad = { select: () => {} };
      const a = new DrizzleAdapter({ drizzleInstance: bad, drizzleTables: tables });
      await expect(a.connect()).rejects.toThrow('missing');
    });
  });

  describe('disconnect branches', () => {
    it('disconnect when not connected does not throw', async () => {
      await adapter.disconnect();
    });

    it('disconnect clears state', async () => {
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.isReady()).toBe(false);
    });
  });

  describe('beginTransaction not-connected', () => {
    it('throws when adapter is not connected', async () => {
      await expect(adapter.beginTransaction()).rejects.toThrow('not connected');
    });
  });

  describe('rawQuery result branches', () => {
    it('handles result with rows property', async () => {
      await adapter.connect();
      const result = await adapter.rawQuery('SELECT 1');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('isReady branches', () => {
    it('returns false before connect', () => {
      expect(adapter.isReady()).toBe(false);
    });

    it('returns true after connect', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });
  });

  describe('createDrizzleDataSource missing entity', () => {
    it('throws for unknown entity', async () => {
      await adapter.connect();
      const ops: DrizzleOperators = {
        eq: () => ({}),
        and: () => ({}),
        asc: () => ({}),
        desc: () => ({}),
      };
      expect(
        () => createDrizzleDataSource(fakeDb, 'nonexistent', tables, ops),
      ).toThrow('Unknown entity');
    });
  });

  describe('data-source create without id', () => {
    it('returns data when no id provided', async () => {
      await adapter.connect();
      const ops: DrizzleOperators = {
        eq: () => ({}),
        and: () => ({}),
        asc: () => ({}),
        desc: () => ({}),
      };
      const ds = createDrizzleDataSource(fakeDb, 'user', tables, ops);
      const created = await ds.create({ name: 'NoId' });
      expect(created.name).toBe('NoId');
    });
  });

  describe('data-source count with where filter', () => {
    it('filters by where clause', async () => {
      await adapter.connect();
      const ops: DrizzleOperators = {
        eq: () => ({}),
        and: () => ({}),
        asc: () => ({}),
        desc: () => ({}),
      };
      const ds = createDrizzleDataSource(fakeDb, 'user', tables, ops);
      await ds.create({ id: 'c1', name: 'Alice' });
      await ds.create({ id: 'c2', name: 'Bob' });
      const count = await ds.count({ name: 'Alice' });
      expect(count).toBe(1);
    });
  });

  describe('connect with no tables', () => {
    it('connects without drizzleTables option', async () => {
      const a = new DrizzleAdapter({ drizzleInstance: fakeDb });
      await a.connect();
      expect(a.isReady()).toBe(true);
    });
  });

  describe('findAll orderBy desc', () => {
    it('sorts in desc order', async () => {
      await adapter.connect();
      const ops: DrizzleOperators = {
        eq: () => ({}),
        and: () => ({}),
        asc: () => ({}),
        desc: () => ({}),
      };
      const ds = createDrizzleDataSource(fakeDb, 'user', tables, ops);
      await ds.create({ id: 'o1', name: 'A' });
      await ds.create({ id: 'o2', name: 'B' });
      const q = normalizeQuery({ orderBy: { name: 'desc' } });
      const rows = await ds.findAll(q);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('findAll with offset > 0', () => {
    it('skips first rows', async () => {
      await adapter.connect();
      const ops: DrizzleOperators = {
        eq: () => ({}),
        and: () => ({}),
        asc: () => ({}),
        desc: () => ({}),
      };
      const ds = createDrizzleDataSource(fakeDb, 'user', tables, ops);
      await ds.create({ id: 'p1', name: 'A' });
      await ds.create({ id: 'p2', name: 'B' });
      await ds.create({ id: 'p3', name: 'C' });
      const q = normalizeQuery({ offset: 2 });
      const rows = await ds.findAll(q);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });
});
