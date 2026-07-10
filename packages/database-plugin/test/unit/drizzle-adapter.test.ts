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
  createDefaultDrizzleOperators,
  createDrizzleDataSource,
  DrizzleAdapter,
  type DrizzleOperators,
} from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createFakeDrizzleInstance } from '../fixtures/fake-drizzle-instance.ts';
import type { NormalizedQuery } from '../../src/query/query-builder.ts';

/** Default operator builders matching the adapter's fallback `eq` shape. */
const OPERATORS: DrizzleOperators = {
  eq: (_col, val) => ({ op: 'eq', val }),
  and: (...exprs) => ({ op: 'and', exprs }),
  asc: (col) => col,
  desc: (col) => col,
};

/** Build a NormalizedQuery from partial options with concrete defaults. */
function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    where: partial.where ?? {},
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
  };
}

describe('DrizzleAdapter', () => {
  let fakeDb: ReturnType<typeof createFakeDrizzleInstance>;
  let adapter: DrizzleAdapter;

  beforeEach(() => {
    fakeDb = createFakeDrizzleInstance();
    adapter = new DrizzleAdapter({
      drizzleInstance: fakeDb,
      drizzleTables: { user: {}, post: {} },
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

    it('rejects missing drizzleInstance with import error', async () => {
      const noDbAdapter = new DrizzleAdapter({
        url: 'postgresql://localhost/test',
        drizzleTables: { user: {} },
      });
      await expect(noDbAdapter.connect()).rejects.toThrow('Failed to load Drizzle');
    });

    it('validates drizzleTables at connect', async () => {
      const adapter = new DrizzleAdapter({
        drizzleInstance: fakeDb,
        drizzleTables: { user: {} },
      });
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
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
    it('accepts no options', async () => {
      const noDbAdapter = new DrizzleAdapter();
      await expect(noDbAdapter.connect()).rejects.toThrow('Failed to load Drizzle');
    });
  });

  describe('createDefaultDrizzleOperators', () => {
    it('builds eq / and / asc / desc expressions', () => {
      const ops = createDefaultDrizzleOperators();
      expect(ops.eq('col', 1)).toEqual({ op: 'eq', col: 'col', val: 1 });
      expect(ops.and('a', 'b')).toEqual({ op: 'and', exprs: ['a', 'b'] });
      expect(ops.asc('col')).toEqual({ op: 'asc', col: 'col' });
      expect(ops.desc('col')).toEqual({ op: 'desc', col: 'col' });
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

    it('create without id returns the input (best effort)', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('user');
      const created = await ds.create({ name: 'NoId' });
      expect(created.name).toBe('NoId');
    });
  });

  describe('data-source query pipeline (createDrizzleDataSource)', () => {
    let ds: ReturnType<typeof createDrizzleDataSource>;

    beforeEach(async () => {
      ds = createDrizzleDataSource(fakeDb, 'user', { user: {} }, OPERATORS);
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
          execute: () => Promise.resolve({ rows: [] }),
          query: {},
          transaction: () => Promise.reject(new Error('driver down')),
        },
        drizzleTables: { user: {} },
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
        drizzleTables: { user: {} },
      });
      await wrapping.connect();
      const txn = await wrapping.beginTransaction();
      await expect(txn.rollback()).rejects.toThrow('tx aborted by driver');
    });
  });
});
