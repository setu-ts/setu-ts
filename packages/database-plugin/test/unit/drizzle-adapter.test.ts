/**
 * Unit tests for DrizzleAdapter using a fake Drizzle instance.
 *
 * Tests cover:
 * - connect/disconnect lifecycle
 * - injected-instance structural validation
 * - transaction bridge (commit + rollback)
 * - rawQuery delegation
 * - drizzleTables validation at connect time
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createDrizzleDataSource,
  DrizzleAdapter,
  type DrizzleOperators,
} from '../../src/adapters/drizzle/drizzle-adapter.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';
import type { NormalizedQuery } from '../../src/query/query-builder.ts';
import { getDrizzle } from '../../src/index.ts';
import { DatabaseService } from '../../src/services/database-service.ts';

/** Default operator builders matching the adapter's fallback `eq` shape. */
const OPERATORS: DrizzleOperators = {
  eq: (col, val) => ({ op: 'eq', col, val }),
  and: (...exprs) => ({ op: 'and', exprs }),
  or: (...exprs) => ({ op: 'or', exprs }),
  gt: (col, val) => ({ op: 'gt', col, val }),
  gte: (col, val) => ({ op: 'gte', col, val }),
  lt: (col, val) => ({ op: 'lt', col, val }),
  lte: (col, val) => ({ op: 'lte', col, val }),
  inArray: (col, values) => ({ op: 'inArray', col, values }),
  isNull: (col) => ({ op: 'isNull', col }),
  sql: (strings, ...values) => ({ op: 'sql', text: [...strings], values }),
  asc: (col) => ({ op: 'asc', col }),
  desc: (col) => ({ op: 'desc', col }),
  count: () => ({ op: 'count' }),
};

const USER_TABLE = createFakeDrizzleTable('user');
const POST_TABLE = createFakeDrizzleTable('post');

/** Build a NormalizedQuery from partial options with concrete defaults. */
function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    where: partial.where ?? {},
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
  };
}

describe('DrizzleAdapter', () => {
  let fakeDb: ReturnType<typeof createFakeDrizzleInstance>;
  let adapter: DrizzleAdapter;

  beforeEach(() => {
    fakeDb = createFakeDrizzleInstance();
    adapter = new DrizzleAdapter({
      drizzleInstance: fakeDb,
      drizzleTables: { user: USER_TABLE, post: POST_TABLE },
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

  describe('injected-instance structural validation', () => {
    it('accepts injected drizzleInstance with required shape', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });

    it('rejects missing drizzleInstance with a configured-driver requirement', async () => {
      const noDbAdapter = new DrizzleAdapter({
        url: 'postgresql://localhost/test',
        drizzleTables: { user: USER_TABLE },
      });
      await expect(noDbAdapter.connect()).rejects.toThrow('requires options.drizzleInstance');
    });

    it('validates drizzleTables at connect', async () => {
      const adapter = new DrizzleAdapter({
        drizzleInstance: fakeDb,
        drizzleTables: { user: USER_TABLE },
      });
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });

    it('accepts builders without execute and refuses only raw queries', async () => {
      const noExecute = {
        select: fakeDb.select,
        insert: fakeDb.insert,
        update: fakeDb.update,
        delete: fakeDb.delete,
        transaction: fakeDb.transaction,
      };
      const noExecuteAdapter = new DrizzleAdapter({
        drizzleInstance: noExecute,
        drizzleTables: { user: USER_TABLE },
      });
      await noExecuteAdapter.connect();

      const service = new DatabaseService(
        noExecuteAdapter,
        (entity) => noExecuteAdapter.createDataSource(entity),
        'drizzle',
      );
      expect(getDrizzle<typeof noExecute>(service)).toBe(noExecute);
      await service.transaction(async (uow) => {
        expect(getDrizzle<typeof noExecute>(uow)).toBe(fakeDb);
        expect(await uow.getRepository('user').findAll()).toEqual([]);
      });
      await expect(noExecuteAdapter.rawQuery('SELECT 1')).rejects.toThrow(
        "Configured Drizzle instance does not support raw execute(); use Drizzle's typed query builder for this driver.",
      );
    });

    it('preserves raw execute parameters and row results', async () => {
      await adapter.connect();
      expect(await adapter.rawQuery('SELECT ?', [1])).toEqual([]);
      const call = fakeDb.recordedCalls.find((entry) => entry.action === 'execute');
      expect(call?.args.values).toEqual({ sql: 'SELECT ?', params: [1] });
    });
  });

  describe('beginTransaction', () => {
    it('throws when not connected', async () => {
      await expect(adapter.beginTransaction()).rejects.toThrow('not connected');
    });

    it('returns transaction handle when connected', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      expect(txn).toBeDefined();
      expect(typeof txn.commit).toBe('function');
      expect(typeof txn.rollback).toBe('function');
    });

    it('commit resolves', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.commit();
    });

    it('rollback resolves', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.rollback();
    });
  });

  describe('constructor options', () => {
    it('requires an injected configured driver when options are absent', async () => {
      const noDbAdapter = new DrizzleAdapter();
      await expect(noDbAdapter.connect()).rejects.toThrow('requires options.drizzleInstance');
    });
  });

  describe('createDataSourceForEntity', () => {
    it('throws before connect', () => {
      expect(() => adapter.createDataSourceForEntity('user')).toThrow('not connected');
    });

    it('create then findById reads the row back', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('user');
      const created = await ds.create({ id: 'u1', name: 'Alice', email: 'a@x.io' });
      expect(created.name).toBe('Alice');
      const found = await ds.findById('u1');
      expect(found?.name).toBe('Alice');
    });

    it('findById returns null when the row is absent', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('user');
      expect(await ds.findById('nope')).toBeNull();
    });

    it('create without id returns the driver-generated row', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('user');
      const created = await ds.create({ name: 'NoId' });
      expect(created.name).toBe('NoId');
    });
  });

  describe('data-source query pipeline (createDrizzleDataSource)', () => {
    let ds: ReturnType<typeof createDrizzleDataSource>;

    beforeEach(async () => {
      ds = createDrizzleDataSource(fakeDb, 'user', { user: USER_TABLE }, OPERATORS);
      await ds.create({ id: 'u1', name: 'Alice', role: 'admin' });
      await ds.create({ id: 'u2', name: 'Bob', role: 'user' });
      await ds.create({ id: 'u3', name: 'Carol', role: 'admin' });
    });

    it('filters by where and sorts descending', async () => {
      const admins = await ds.findAll(
        query({ where: { role: 'admin' }, orderBy: { name: 'desc' } }),
      );
      expect(admins.map((r) => r.name)).toEqual(['Carol', 'Alice']);
    });

    it('paginates and projects selected fields', async () => {
      const page = await ds.findAll(
        query({ orderBy: { name: 'asc' }, limit: 1, offset: 1, select: ['name'] }),
      );
      expect(page).toEqual([{ name: 'Bob' }]);
    });

    it('returns all rows when no options are given', async () => {
      const all = await ds.findAll(query());
      expect(all.length).toBe(3);
    });

    it('translates a portable expression into Drizzle operators', async () => {
      await ds.findAll(
        query({
          where: { role: 'admin' },
          filter: {
            type: 'or',
            filters: [
              { type: 'comparison', field: 'name', operator: 'contains', value: 'Ali' },
              { type: 'comparison', field: 'id', operator: 'in', value: ['u3'] },
            ],
          },
        }),
      );

      const call = fakeDb.recordedCalls.filter((entry) => entry.action === 'where').at(-1);
      expect(call?.args.expression).toEqual({
        op: 'and',
        exprs: [
          { op: 'eq', col: USER_TABLE.role, val: 'admin' },
          {
            op: 'or',
            exprs: [
              {
                op: 'sql',
                text: ['', ' like ', " escape '\\'"],
                values: [USER_TABLE.name, '%Ali%'],
              },
              { op: 'inArray', col: USER_TABLE.id, values: ['u3'] },
            ],
          },
        ],
      });
    });

    it('escapes LIKE metacharacters and preserves null membership', async () => {
      await ds.findAll(
        query({
          filter: {
            type: 'or',
            filters: [
              { type: 'comparison', field: 'name', operator: 'contains', value: '50%_off\\now' },
              {
                type: 'comparison',
                field: 'deletedAt',
                operator: 'in',
                value: [null, '2026-01-01'],
              },
            ],
          },
        }),
      );

      const call = fakeDb.recordedCalls.filter((entry) => entry.action === 'where').at(-1);
      expect(call?.args.expression).toEqual({
        op: 'or',
        exprs: [
          {
            op: 'sql',
            // The trailing chunk carries `ESCAPE '\'`; without it the escaping
            // in the bound pattern is inert on a dialect (SQLite) that has no
            // default escape character.
            text: ['', ' like ', " escape '\\'"],
            values: [USER_TABLE.name, '%50\\%\\_off\\\\now%'],
          },
          {
            op: 'or',
            exprs: [
              { op: 'isNull', col: USER_TABLE.deletedAt },
              { op: 'inArray', col: USER_TABLE.deletedAt, values: ['2026-01-01'] },
            ],
          },
        ],
      });
    });

    it('translates every scalar comparison leaf to its native operator', async () => {
      const leaves = [
        ['eq', 'eq'],
        ['gt', 'gt'],
        ['gte', 'gte'],
        ['lt', 'lt'],
        ['lte', 'lte'],
      ] as const;

      for (const [operator, expected] of leaves) {
        await ds.findAll(
          query({ filter: { type: 'comparison', field: 'name', operator, value: 'Alice' } }),
        );
        const call = fakeDb.recordedCalls.filter((entry) => entry.action === 'where').at(-1);
        expect(call?.args.expression).toEqual({
          op: expected,
          col: USER_TABLE.name,
          val: 'Alice',
        });
      }
    });

    it('translates a null-only membership list to IS NULL', async () => {
      await ds.findAll(
        query({
          filter: { type: 'comparison', field: 'deletedAt', operator: 'in', value: [null] },
        }),
      );

      const call = fakeDb.recordedCalls.filter((entry) => entry.action === 'where').at(-1);
      expect(call?.args.expression).toEqual({ op: 'isNull', col: USER_TABLE.deletedAt });
    });

    it('emits no predicate for an expression that is true by identity', async () => {
      const before = fakeDb.recordedCalls.filter((entry) => entry.action === 'where').length;

      await ds.findAll(query({ filter: { type: 'and', filters: [] } }));

      expect(fakeDb.recordedCalls.filter((entry) => entry.action === 'where').length).toBe(before);
    });

    it('emits a match-nothing predicate for an expression that is false by identity', async () => {
      await ds.findAll(query({ filter: { type: 'or', filters: [] } }));
      expect(
        fakeDb.recordedCalls.filter((entry) => entry.action === 'where').at(-1)?.args.expression,
      ).toEqual({ op: 'inArray', col: USER_TABLE.id, values: [] });

      await ds.findAll(
        query({
          filter: {
            type: 'and',
            filters: [
              { type: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
              { type: 'or', filters: [] },
            ],
          },
        }),
      );
      expect(
        fakeDb.recordedCalls.filter((entry) => entry.action === 'where').at(-1)?.args.expression,
      ).toEqual({ op: 'inArray', col: USER_TABLE.id, values: [] });
    });

    it('counts through a portable expression', async () => {
      await ds.count({ role: 'admin' }, {
        type: 'comparison',
        field: 'name',
        operator: 'gte',
        value: 'A',
      });

      expect(
        fakeDb.recordedCalls.filter((entry) => entry.action === 'where').at(-1)?.args.expression,
      ).toEqual({
        op: 'and',
        exprs: [
          { op: 'eq', col: USER_TABLE.role, val: 'admin' },
          { op: 'gte', col: USER_TABLE.name, val: 'A' },
        ],
      });
    });

    it('refuses a filter when the required operators were not supplied', async () => {
      const bare = createDrizzleDataSource(fakeDb, 'user', { user: USER_TABLE }, {
        eq: OPERATORS.eq,
        and: OPERATORS.and,
        asc: OPERATORS.asc,
        desc: OPERATORS.desc,
        count: OPERATORS.count,
      });

      await expect(
        bare.findAll(
          query({ filter: { type: 'comparison', field: 'name', operator: 'eq', value: 'Alice' } }),
        ),
      ).rejects.toThrow('Drizzle filter operators are unavailable');
    });

    it('counts with and without a where filter', async () => {
      expect(await ds.count({})).toBe(3);
      expect(await ds.count({ role: 'admin' })).toBe(2);
    });

    it('updates a row and reads the change back', async () => {
      const updated = await ds.update('u1', { name: 'Alice2' });
      expect(updated.name).toBe('Alice2');
      const found = await ds.findById('u1');
      expect(found?.name).toBe('Alice2');
    });

    it('throws when updating an absent row', async () => {
      await expect(ds.update('missing', { name: 'X' })).rejects.toThrow('not found');
    });

    it('deletes a row and reports success', async () => {
      expect(await ds.delete('u2')).toBe(true);
      expect(await ds.findById('u2')).toBeNull();
    });
  });

  describe('createDrizzleDataSource — unknown entity', () => {
    it('throws when the entity is not registered', () => {
      expect(() => createDrizzleDataSource(fakeDb, 'ghost', {}, OPERATORS)).toThrow(
        "Unknown entity 'ghost'",
      );
    });
  });

  describe('transaction failure paths', () => {
    it('rejects beginTransaction when the driver cannot open a transaction', async () => {
      const failing = new DrizzleAdapter({
        drizzleInstance: {
          select: () => ({ from: () => Promise.resolve([]) }),
          insert: () => ({ values: () => ({ execute: () => Promise.resolve([]) }) }),
          update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
          delete: () => ({ where: () => Promise.resolve() }),
          $count: () => Promise.resolve(0),
          execute: () => Promise.resolve({ rows: [] }),
          query: {},
          transaction: () => Promise.reject(new Error('driver down')),
        },
        drizzleTables: { user: USER_TABLE },
      });
      await failing.connect();
      await expect(failing.beginTransaction()).rejects.toThrow(
        'Drizzle transaction failed to start',
      );
    });

    it('rethrows a non-sentinel error surfaced during rollback', async () => {
      const inner = createFakeDrizzleInstance();
      const wrapping = new DrizzleAdapter({
        drizzleInstance: {
          select: inner.select.bind(inner),
          insert: inner.insert.bind(inner),
          update: inner.update.bind(inner),
          delete: inner.delete.bind(inner),
          $count: inner.$count.bind(inner),
          execute: inner.execute.bind(inner),
          query: inner.query,
          transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
            try {
              return await cb(inner);
            } catch {
              // Simulate a driver that reports its own abort error, not our sentinel.
              throw new Error('tx aborted by driver');
            }
          },
        },
        drizzleTables: { user: USER_TABLE },
      });
      await wrapping.connect();
      const txn = await wrapping.beginTransaction();
      await expect(txn.rollback()).rejects.toThrow('tx aborted by driver');
    });
  });
});
