/**
 * Unit tests for PrismaAdapter using a fake Prisma client.
 *
 * Tests cover:
 * - connect/disconnect lifecycle
 * - injected-client structural validation
 * - two-deferred transaction bridge (commit + rollback)
 * - $queryRawUnsafe delegation
 * - rawQuery delegation
 * - no $use / enableQueryLogging (deleted from real Prisma v7)
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import type { IAdapterTransaction } from '../../src/adapters/adapter.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import type { NormalizedQuery } from '../../src/query/query-builder.ts';

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

/** Minimal Prisma-client-shaped stub whose `User` delegate write ops reject. */
function createRejectingClient(err: unknown) {
  const delegate = {
    findUnique: () => Promise.resolve(null),
    findMany: () => Promise.resolve([]),
    create: (args: { data: Record<string, unknown> }) => Promise.resolve(args.data),
    update: () => Promise.reject(err),
    delete: () => Promise.reject(err),
    count: () => Promise.resolve(0),
  };
  return {
    $connect: () => Promise.resolve(),
    $disconnect: () => Promise.resolve(),
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(delegate),
    $queryRawUnsafe: () => Promise.resolve([]),
    user: delegate,
  };
}

describe('PrismaAdapter', () => {
  let fakeClient: ReturnType<typeof createFakePrismaClient>;
  let adapter: PrismaAdapter;

  beforeEach(() => {
    fakeClient = createFakePrismaClient();
    adapter = new PrismaAdapter({ prismaClient: fakeClient });
  });

  describe('connect / disconnect / isReady', () => {
    it('is not ready before connect', () => {
      expect(adapter.isReady()).toBe(false);
    });

    it('is ready after connect', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
      expect(fakeClient.connected).toBe(true);
    });

    it('is not ready after disconnect', async () => {
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.isReady()).toBe(false);
      expect(fakeClient.disconnected).toBe(true);
    });
  });

  describe('injected-client structural validation', () => {
    it('accepts injected prismaClient with required methods', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });

    it('rejects missing prismaClient with import error', async () => {
      const noClientAdapter = new PrismaAdapter({ url: 'postgresql://localhost/test' });
      await expect(noClientAdapter.connect()).rejects.toThrow('Failed to load Prisma');
    });

    it('uses the fake client (not unused)', async () => {
      await adapter.connect();
      expect(fakeClient.connected).toBe(true);
    });
  });

  describe('beginTransaction — two-deferred bridge', () => {
    it('throws when not connected', async () => {
      await expect(adapter.beginTransaction()).rejects.toThrow('not connected');
    });

    it('returns transaction handle when connected', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      expect(txn).toBeDefined();
      expect(typeof txn.commit).toBe('function');
      expect(typeof txn.rollback).toBe('function');
      // IAdapterTransaction has createDataSource
      const adapterTxn = txn as IAdapterTransaction;
      expect(typeof adapterTxn.createDataSource).toBe('function');
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

    it('createDataSource returns a DataSource', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      expect(ds).toBeDefined();
      await txn.commit();
    });
  });

  describe('rawQuery delegates $queryRawUnsafe', () => {
    it('calls $queryRawUnsafe with sql and params', async () => {
      await adapter.connect();
      await adapter.rawQuery('SELECT 1', []);
      const call = fakeClient.recordedCalls.find(
        (c) => c.action === 'execute' && c.args.sql === 'SELECT 1',
      );
      expect(call).toBeDefined();
    });
  });

  describe('createDataSourceForEntity', () => {
    it('throws before connect', () => {
      expect(() => adapter.createDataSourceForEntity('User')).toThrow('not connected');
    });

    it('throws when the model delegate is absent', async () => {
      await adapter.connect();
      expect(() => adapter.createDataSourceForEntity('Ghost')).toThrow("no model 'Ghost'");
    });

    it('create then findById reads the row back', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('User');
      const created = await ds.create({ id: 'u1', name: 'Alice' });
      expect(created.name).toBe('Alice');
      const found = await ds.findById('u1');
      expect(found?.name).toBe('Alice');
    });
  });

  describe('data-source query pipeline (findMany arg translation)', () => {
    let ds: DataSource;

    beforeEach(async () => {
      await adapter.connect();
      ds = adapter.createDataSourceForEntity('User');
      await ds.create({ id: 'u1', name: 'Alice', role: 'admin' });
      await ds.create({ id: 'u2', name: 'Bob', role: 'user' });
      await ds.create({ id: 'u3', name: 'Carol', role: 'admin' });
    });

    it('translates where + orderBy + take + skip + select into findMany args', async () => {
      const rows = await ds.findAll(
        query({
          where: { role: 'admin' },
          orderBy: { name: 'asc' },
          limit: 1,
          offset: 1,
          select: ['name'],
        }),
      );
      expect(rows).toEqual([{ name: 'Carol' }]);
      const call = fakeClient.recordedCalls.find((c) => c.action === 'findMany');
      expect(call?.args).toEqual({
        where: { role: 'admin' },
        orderBy: { name: 'asc' },
        take: 1,
        skip: 1,
        select: { name: true },
      });
    });

    it('sends empty args when the query has no options', async () => {
      const rows = await ds.findAll(query());
      expect(rows.length).toBe(3);
    });

    it('counts with a where filter', async () => {
      expect(await ds.count({})).toBe(3);
      expect(await ds.count({ role: 'admin' })).toBe(2);
    });

    it('updates a row and reads the change back', async () => {
      const updated = await ds.update('u1', { name: 'Alice2' });
      expect(updated.name).toBe('Alice2');
    });

    it('maps a P2025 update error to a not-found error', async () => {
      await expect(ds.update('missing', { name: 'X' })).rejects.toThrow('not found');
    });

    it('deletes a row and reports success', async () => {
      expect(await ds.delete('u2')).toBe(true);
      expect(await ds.findById('u2')).toBeNull();
    });

    it('returns false when deleting an absent row (P2025)', async () => {
      expect(await ds.delete('missing')).toBe(false);
    });
  });

  describe('data-source rethrows non-P2025 errors', () => {
    it('rethrows a non-P2025 update error unchanged', async () => {
      const failing = new PrismaAdapter({
        prismaClient: createRejectingClient(new Error('db down')),
      });
      await failing.connect();
      const ds = failing.createDataSourceForEntity('User');
      await expect(ds.update('u1', { name: 'X' })).rejects.toThrow('db down');
    });

    it('rethrows a non-P2025 delete error unchanged', async () => {
      const failing = new PrismaAdapter({
        prismaClient: createRejectingClient(new Error('db down')),
      });
      await failing.connect();
      const ds = failing.createDataSourceForEntity('User');
      await expect(ds.delete('u1')).rejects.toThrow('db down');
    });
  });

  describe('transaction failure paths', () => {
    it('rejects beginTransaction when $transaction cannot open', async () => {
      const failing = new PrismaAdapter({
        prismaClient: {
          $connect: () => Promise.resolve(),
          $disconnect: () => Promise.resolve(),
          $transaction: () => Promise.reject(new Error('cannot open')),
          $queryRawUnsafe: () => Promise.resolve([]),
        },
      });
      await failing.connect();
      await expect(failing.beginTransaction()).rejects.toThrow(
        'Prisma transaction failed to start',
      );
    });

    it('rethrows a non-sentinel error surfaced during rollback', async () => {
      const inner = createFakePrismaClient();
      const wrapping = new PrismaAdapter({
        prismaClient: {
          $connect: () => Promise.resolve(),
          $disconnect: () => Promise.resolve(),
          $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
            try {
              return await fn(inner);
            } catch {
              throw new Error('tx aborted by driver');
            }
          },
          $queryRawUnsafe: () => Promise.resolve([]),
          user: inner.user,
        },
      });
      await wrapping.connect();
      const txn = await wrapping.beginTransaction();
      await expect(txn.rollback()).rejects.toThrow('tx aborted by driver');
    });
  });
});
