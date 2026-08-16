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
import { UnsupportedFilterOperatorError } from '../../src/errors.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import type { IAdapterTransaction } from '@setu-ts/common';
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
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
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

    it('rejects missing prismaClient with a generated-client requirement', async () => {
      const noClientAdapter = new PrismaAdapter({ url: 'postgresql://localhost/test' });
      await expect(noClientAdapter.connect()).rejects.toThrow('requires options.prismaClient');
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

    it('translates a portable expression into Prisma where input', async () => {
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

      const call = fakeClient.recordedCalls.find((entry) => entry.action === 'findMany');
      expect(call?.args.where).toEqual({
        AND: [
          { role: 'admin' },
          { OR: [{ name: { contains: 'Ali' } }, { id: { in: ['u3'] } }] },
        ],
      });
    });

    it('translates every scalar comparison leaf into Prisma input', async () => {
      const leaves = [
        ['eq', { name: 'Alice' }],
        ['gt', { name: { gt: 'Alice' } }],
        ['gte', { name: { gte: 'Alice' } }],
        ['lt', { name: { lt: 'Alice' } }],
        ['lte', { name: { lte: 'Alice' } }],
      ] as const;

      for (const [operator, expected] of leaves) {
        fakeClient.recordedCalls.length = 0;
        await ds.findAll(
          query({ filter: { type: 'comparison', field: 'name', operator, value: 'Alice' } }),
        );
        const call = fakeClient.recordedCalls.find((entry) => entry.action === 'findMany');
        expect(call?.args.where).toEqual(expected);
      }
    });

    it('translates a null-only membership list into an equality on null', async () => {
      await ds.findAll(
        query({
          filter: { type: 'comparison', field: 'deletedAt', operator: 'in', value: [null] },
        }),
      );

      const call = fakeClient.recordedCalls.find((entry) => entry.action === 'findMany');
      expect(call?.args.where).toEqual({ deletedAt: null });
    });

    it('counts through a portable expression conjoined with equality', async () => {
      fakeClient.recordedCalls.length = 0;
      await ds.count({ role: 'admin' }, {
        type: 'comparison',
        field: 'name',
        operator: 'contains',
        value: 'Ali',
      });

      const call = fakeClient.recordedCalls.find((entry) => entry.action === 'count');
      expect(call?.args.where).toEqual({
        AND: [{ role: 'admin' }, { name: { contains: 'Ali' } }],
      });
    });

    it('translates null membership into an explicit null branch', async () => {
      await ds.findAll(
        query({
          filter: {
            type: 'comparison',
            field: 'deletedAt',
            operator: 'in',
            value: [null, '2026-01-01'],
          },
        }),
      );

      const call = fakeClient.recordedCalls.find((entry) => entry.action === 'findMany');
      expect(call?.args.where).toEqual({
        OR: [
          { deletedAt: null },
          { deletedAt: { in: ['2026-01-01'] } },
        ],
      });
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

  describe('contains — connector-aware translation (X12-1)', () => {
    /** Run a `contains` filter and return the `where` the delegate received. */
    async function translatedWhere(
      client: ReturnType<typeof createFakePrismaClient>,
      value: string,
      options?: {
        provider?: 'postgresql' | 'postgres' | 'mysql' | 'sqlserver' | 'cockroachdb' | 'sqlite';
      },
    ): Promise<Record<string, unknown>> {
      const adapter = new PrismaAdapter({
        prismaClient: client,
        ...(options?.provider !== undefined ? { provider: options.provider } : {}),
      });
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.findAll(
        query({
          filter: { type: 'comparison', field: 'name', operator: 'contains', value },
        }),
      );
      const call = client.recordedCalls.find((c) => c.action === 'findMany');
      return call?.args.where as Record<string, unknown>;
    }

    it('escapes % and _ on an escaping connector (postgresql)', async () => {
      const client = createFakePrismaClient();
      const where = await translatedWhere(client, '50% off');
      expect(where).toEqual({ name: { contains: '50\\% off' } });
    });

    it('escapes on every escaping connector', async () => {
      for (const provider of ['postgres', 'mysql', 'sqlserver', 'cockroachdb']) {
        const client = createFakePrismaClient({ activeProvider: provider });
        const where = await translatedWhere(client, 'a_b');
        expect(where).toEqual({ name: { contains: 'a\\_b' } });
      }
    });

    it('refuses on sqlite with a named error', async () => {
      const adapter = new PrismaAdapter({
        prismaClient: createFakePrismaClient({ activeProvider: 'sqlite' }),
      });
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      // Translation is synchronous, so the refusal throws from findAll rather
      // than rejecting.
      expect(() =>
        ds.findAll(
          query({
            filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'x' },
          }),
        )
      ).toThrow(UnsupportedFilterOperatorError);
    });

    it('refuses when the connector cannot be determined, naming the provider option', async () => {
      // A client with no `_activeProvider` field at all — structural detection
      // finds nothing, so the adapter refuses and names the `provider` option.
      const bare = {
        $connect: () => Promise.resolve(),
        $disconnect: () => Promise.resolve(),
        $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(bare),
        $queryRawUnsafe: () => Promise.resolve([]),
        user: {
          findUnique: () => Promise.resolve(null),
          findMany: () => Promise.resolve([]),
          create: (a: { data: Record<string, unknown> }) => Promise.resolve(a.data),
          update: () => Promise.reject(new Error('nope')),
          delete: () => Promise.reject(new Error('nope')),
          count: () => Promise.resolve(0),
        },
      };
      const adapter = new PrismaAdapter({ prismaClient: bare });
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      expect(() =>
        ds.findAll(
          query({
            filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'x' },
          }),
        )
      ).toThrow(/provider/);
    });

    it('lets an explicit provider option beat structural detection', async () => {
      // The client says sqlite, but the application says postgresql — the
      // explicit option wins, so the filter escapes rather than refuses.
      const client = createFakePrismaClient({ activeProvider: 'sqlite' });
      const where = await translatedWhere(client, '50% off', { provider: 'postgresql' });
      expect(where).toEqual({ name: { contains: '50\\% off' } });
    });

    it('detects the connector structurally from the client', async () => {
      // No explicit provider: the adapter reads `_activeProvider` from the
      // client. A sqlite client refuses; the error names the connector.
      const adapter = new PrismaAdapter({
        prismaClient: createFakePrismaClient({ activeProvider: 'sqlite' }),
      });
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      let caught: unknown;
      try {
        await ds.findAll(
          query({
            filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'x' },
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnsupportedFilterOperatorError);
      expect((caught as UnsupportedFilterOperatorError).connector).toBe('sqlite');
      expect((caught as UnsupportedFilterOperatorError).operator).toBe('contains');
    });
  });
});
