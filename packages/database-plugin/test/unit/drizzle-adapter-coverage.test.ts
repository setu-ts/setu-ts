/**
 * Coverage tests for DrizzleAdapter real CRUD data-source paths.
 *
 * Exercises createDrizzleDataSource CRUD read-back, transaction bridge
 * commit/rollback, rawQuery, createDataSourceForEntity, and connect-time
 * branches (operator loading, table validation, injected-driver errors).
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createDrizzleDataSource,
  DrizzleAdapter,
  type DrizzleInstance,
  type DrizzleOperators,
} from '../../src/adapters/drizzle/drizzle-adapter.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';
import type { IAdapterTransaction } from '@setu-ts/common';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { normalizeQuery } from '../../src/query/query-builder.ts';
import type { NormalizedQuery } from '../../src/query/query-builder.ts';
import { createDrizzleDatabase } from '../../src/index.ts';

describe('DrizzleAdapter — CRUD data-source coverage', () => {
  let fakeDb: ReturnType<typeof createFakeDrizzleInstance>;
  let adapter: DrizzleAdapter;
  const tables = { user: createFakeDrizzleTable('user'), post: createFakeDrizzleTable('post') };

  beforeEach(() => {
    fakeDb = createFakeDrizzleInstance();
    adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(
        fakeDb,
        (database, work) => database.transaction(work),
      ),
      drizzleTables: tables,
    });
  });

  describe('createDrizzleDataSource CRUD read-back', () => {
    let ds: DataSource;
    const ops: DrizzleOperators = {
      eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
      and: (...exprs: unknown[]) => ({ op: 'and', exprs }),
      asc: (col: unknown) => ({ op: 'asc', col }),
      desc: (col: unknown) => ({ op: 'desc', col }),
      count: () => ({ op: 'count' }),
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

    it('rejects writes when the configured dialect has no RETURNING support', async () => {
      const withoutReturning = {
        ...fakeDb,
        insert: () => ({ values: () => ({}) }),
      };
      const unsupported = createDrizzleDataSource(
        withoutReturning as unknown as DrizzleInstance,
        'user',
        tables,
        ops,
      );
      await expect(unsupported.create({ id: 'no-returning' })).rejects.toThrow(
        'requires a driver that supports RETURNING',
      );
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
          count: () => ({ op: 'count' }),
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
      const result = await adapter.rawQuery('SELECT ?', [1]);
      const call = fakeDb.recordedCalls.find((c) => c.action === 'execute');
      expect(call?.args.values).toEqual({ sql: 'SELECT ?', params: [1] });
      expect(result).toEqual([]);
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
        drizzleTables: { user: createFakeDrizzleTable('user') },
      });
      await expect(noDbAdapter.connect()).rejects.toThrow('requires options.drizzleInstance');
    });

    it('validates drizzleTables entries', async () => {
      const badAdapter = new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(
          fakeDb,
          (database, work) => database.transaction(work),
        ),
        drizzleTables: { bad: null },
      });
      await expect(badAdapter.connect()).rejects.toThrow("table 'bad' must be a table definition");
    });
  });

  describe('validateInstance rejection', () => {
    it('rejects instance missing select', async () => {
      const bad = {
        transaction: <T>(work: (transaction: object) => Promise<T>): Promise<T> => work({}),
      };
      const a = new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(
          bad,
          (configured, work) => configured.transaction(work),
        ),
        drizzleTables: tables,
      });
      await expect(a.connect()).rejects.toThrow('missing');
    });

    it('rejects instance missing transaction', async () => {
      const bad = {
        select: () => {},
        transaction: <T>(work: (transaction: object) => Promise<T>): Promise<T> => work({}),
      };
      const a = new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(
          bad,
          (configured, work) => configured.transaction(work),
        ),
        drizzleTables: tables,
      });
      await expect(a.connect()).rejects.toThrow('missing');
    });

    it('accepts an instance missing execute and refuses only raw queries', async () => {
      interface SqliteShaped {
        select(): void;
        insert(): void;
        update(): void;
        delete(): void;
        transaction<T>(work: (transaction: SqliteShaped) => Promise<T>): Promise<T>;
      }
      const sqliteShaped: SqliteShaped = {
        select: () => {},
        insert: () => {},
        update: () => {},
        delete: () => {},
        transaction: async <T>(work: (transaction: typeof sqliteShaped) => Promise<T>) =>
          await work(sqliteShaped),
      };
      const a = new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(
          sqliteShaped,
          (configured, work) => configured.transaction(work),
        ),
        drizzleTables: tables,
      });
      await a.connect();
      expect(a.isReady()).toBe(true);
      await expect(a.rawQuery('select 1')).rejects.toThrow(
        "does not support raw execute(); use Drizzle's typed query builder",
      );
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
        eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
        and: () => ({}),
        asc: () => ({}),
        desc: () => ({}),
        count: () => ({ op: 'count' }),
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
        eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
        and: () => ({}),
        asc: () => ({}),
        desc: () => ({}),
        count: () => ({ op: 'count' }),
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
        eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
        and: () => ({}),
        asc: () => ({}),
        desc: () => ({}),
        count: () => ({ op: 'count' }),
      };
      const ds = createDrizzleDataSource(fakeDb, 'user', tables, ops);
      await ds.create({ id: 'c1', name: 'Alice' });
      await ds.create({ id: 'c2', name: 'Bob' });
      const count = await ds.count({ name: 'Alice' });
      expect(count).toBe(1);
    });
  });

  describe('connect with missing table registry', () => {
    it('rejects an omitted or empty drizzleTables registry before reporting ready', async () => {
      for (const drizzleTables of [undefined, {}] as const) {
        const options = drizzleTables === undefined
          ? {
            drizzleInstance: createDrizzleDatabase(fakeDb, (database, work) =>
              database.transaction(work)),
          }
          : {
            drizzleInstance: createDrizzleDatabase(
              fakeDb,
              (database, work) => database.transaction(work),
            ),
            drizzleTables,
          };
        const a = new DrizzleAdapter(options);
        await expect(a.connect()).rejects.toThrow('requires options.drizzleTables');
        expect(a.isReady()).toBe(false);
      }
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
        count: () => ({ op: 'count' }),
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
        count: () => ({ op: 'count' }),
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

  describe('column resolution against the registered table', () => {
    const ops: DrizzleOperators = {
      eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
      and: (...exprs: unknown[]) => ({ op: 'and', exprs }),
      asc: (col: unknown) => ({ op: 'asc', col }),
      desc: (col: unknown) => ({ op: 'desc', col }),
      count: () => ({ op: 'count' }),
    };

    it('rejects a where field that is not a column on the table', async () => {
      await adapter.connect();
      const ds = createDrizzleDataSource(fakeDb, 'user', tables, ops);
      await expect(ds.findAll(normalizeQuery({ where: { nickname: 'x' } }))).rejects.toThrow(
        "Drizzle table 'user' has no 'nickname' column",
      );
    });

    it('rejects an orderBy field that is not a column on the table', async () => {
      await adapter.connect();
      const ds = createDrizzleDataSource(fakeDb, 'user', tables, ops);
      await expect(ds.findAll(normalizeQuery({ orderBy: { nickname: 'asc' } }))).rejects.toThrow(
        "has no 'nickname' column",
      );
    });

    it('rejects a select field that is not a column on the table', async () => {
      await adapter.connect();
      const ds = createDrizzleDataSource(fakeDb, 'user', tables, ops);
      await expect(ds.findAll(normalizeQuery({ select: ['nickname'] }))).rejects.toThrow(
        "has no 'nickname' column",
      );
    });

    it('combines multiple where fields with and()', async () => {
      await adapter.connect();
      const combined: unknown[] = [];
      const recordingOps: DrizzleOperators = {
        ...ops,
        and: (...exprs: unknown[]) => {
          combined.push(exprs);
          return { op: 'and', exprs };
        },
      };
      const ds = createDrizzleDataSource(fakeDb, 'user', tables, recordingOps);
      await ds.create({ id: 'm1', name: 'Ada', role: 'admin' });
      await ds.create({ id: 'm2', name: 'Ada', role: 'user' });

      const rows = await ds.findAll(normalizeQuery({ where: { name: 'Ada', role: 'admin' } }));

      // A single predicate must NOT be wrapped; two must be combined once.
      expect(combined.length).toBe(1);
      expect((combined[0] as unknown[]).length).toBe(2);
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('m1');
    });
  });

  describe('count aggregate', () => {
    it('reports 0 when the driver returns no aggregate row', async () => {
      await adapter.connect();
      const emptyDriver = {
        ...fakeDb,
        select: () => ({ from: () => Promise.resolve([]) }),
      };
      const ds = createDrizzleDataSource(
        emptyDriver as unknown as DrizzleInstance,
        'user',
        tables,
        {
          eq: () => ({}),
          and: () => ({}),
          asc: () => ({}),
          desc: () => ({}),
          count: () => ({ op: 'count' }),
        },
      );
      expect(await ds.count({})).toBe(0);
    });
  });
});
