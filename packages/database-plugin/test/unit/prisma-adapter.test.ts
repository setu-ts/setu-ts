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
import { createPrismaDataSource, PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { UnsupportedFilterOperatorError, UnsupportedQueryFeatureError } from '../../src/errors.ts';
import { PageNormalizationError } from '../../src/query/query-builder.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import type { IAdapterTransaction } from '@setu-ts/common';
import { encodeCursor } from '@setu-ts/common';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import type { NormalizedQuery } from '../../src/query/query-builder.ts';
import type { PrismaSqlProvider } from '../../src/interfaces/index.ts';

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
      const noClientAdapter = new PrismaAdapter(
        {
          url: 'postgresql://localhost/test',
        } as import('../../src/interfaces/index.ts').PrismaAdapterOptions,
      );
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
      // `orderBy` is an ARRAY of single-key objects, never one multi-key
      // object: measured against Prisma 7.10 on live PostgreSQL, a two-key
      // object is rejected outright while an array of any length is accepted
      // and honours element order as sort precedence.
      expect(call?.args).toEqual({
        where: { role: 'admin' },
        orderBy: [{ name: 'asc' }],
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
      // The exported union, not a hand-copied one: a local duplicate silently
      // stopped expressing `mongodb` when the real type gained it.
      options?: { provider?: PrismaSqlProvider },
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

    it('passes the value through unescaped on mongodb', async () => {
      // MongoDB's `contains` compiles to a `$regex` match, where `%` and `_`
      // are already literal — escaping them would search for a backslash the
      // data does not contain. Detected structurally, with no explicit option.
      const client = createFakePrismaClient({ activeProvider: 'mongodb' });
      const where = await translatedWhere(client, '50% off_now');
      expect(where).toEqual({ name: { contains: '50% off_now' } });
    });

    it('accepts mongodb as an explicit provider', async () => {
      // The error for an undetermined connector tells the caller to pass
      // `provider`; that advice has to be followable for every connector the
      // adapter can meet, mongodb included.
      const client = createFakePrismaClient({ activeProvider: 'sqlite' });
      const where = await translatedWhere(client, 'a%b', { provider: 'mongodb' });
      expect(where).toEqual({ name: { contains: 'a%b' } });
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

  describe('composite key support', () => {
    it('emits where: { id } byte-for-byte for a scalar key', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('User');
      await ds.findById('u1');
      const call = fakeClient.recordedCalls.find((c) => c.action === 'findUnique');
      expect(call?.args).toEqual({ where: { id: 'u1' } });
    });

    it('refuses composite findById by name when compositeKeyName is unset', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('User');
      // Without compositeKeyName, composite keys are refused by name.
      await expect(
        ds.findById({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow(UnsupportedQueryFeatureError);
      await expect(
        ds.findById({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow('composite-key');
      await expect(
        ds.findById({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow('prisma');
    });

    it('emits the override compound name when compositeKeyName is set', async () => {
      const entities = {
        User: { compositeKeyName: 'tenantId_userId', keyColumns: ['tenantId', 'userId'] },
      };
      const compAdapter = new PrismaAdapter(
        {
          prismaClient: fakeClient,
          ...(entities !== undefined ? { entities } : {}),
        } as import('../../src/interfaces/index.ts').PrismaAdapterOptions,
      );
      await compAdapter.connect();
      const ds = compAdapter.createDataSourceForEntity('User');
      await ds.create({ tenantId: 't1', userId: 7, name: 'Alice' });
      await ds.findById({ tenantId: 't1', userId: 7 });
      const call = fakeClient.recordedCalls.find((c) => c.action === 'findUnique');
      expect(call?.args).toEqual({
        where: {
          tenantId_userId: { tenantId: 't1', userId: 7 },
        },
      });
    });

    it('uses the override compound name in update', async () => {
      const entities = {
        User: { compositeKeyName: 'tenantId_userId', keyColumns: ['tenantId', 'userId'] },
      };
      const compAdapter = new PrismaAdapter(
        {
          prismaClient: fakeClient,
          ...(entities !== undefined ? { entities } : {}),
        } as import('../../src/interfaces/index.ts').PrismaAdapterOptions,
      );
      await compAdapter.connect();
      const ds = compAdapter.createDataSourceForEntity('User');
      await ds.create({ tenantId: 't1', userId: 7, name: 'Alice' });
      await ds.update({ tenantId: 't1', userId: 7 }, { name: 'Alice2' });
      const call = fakeClient.recordedCalls.find((c) => c.action === 'update');
      expect(call?.args).toEqual({
        where: {
          tenantId_userId: { tenantId: 't1', userId: 7 },
        },
        data: { name: 'Alice2' },
      });
    });

    it('uses the override compound name in delete', async () => {
      const entities = {
        User: { compositeKeyName: 'tenantId_userId', keyColumns: ['tenantId', 'userId'] },
      };
      const compAdapter = new PrismaAdapter(
        {
          prismaClient: fakeClient,
          ...(entities !== undefined ? { entities } : {}),
        } as import('../../src/interfaces/index.ts').PrismaAdapterOptions,
      );
      await compAdapter.connect();
      const ds = compAdapter.createDataSourceForEntity('User');
      await ds.create({ tenantId: 't1', userId: 7, name: 'Alice' });
      await ds.delete({ tenantId: 't1', userId: 7 });
      const call = fakeClient.recordedCalls.find((c) => c.action === 'delete');
      expect(call?.args).toEqual({
        where: {
          tenantId_userId: { tenantId: 't1', userId: 7 },
        },
      });
    });

    it('refuses composite findById by name with UnsupportedQueryFeatureError', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('User');
      await expect(
        ds.findById({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow(UnsupportedQueryFeatureError);
      await expect(
        ds.findById({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow('composite-key');
      await expect(
        ds.findById({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow('prisma');
      await expect(
        ds.findById({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow('compositeKeyName');
    });

    it('refuses composite update by name with UnsupportedQueryFeatureError', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('User');
      await expect(
        ds.update({ tenantId: 't1', userId: 7 }, { name: 'X' }),
      ).rejects.toThrow(UnsupportedQueryFeatureError);
      await expect(
        ds.update({ tenantId: 't1', userId: 7 }, { name: 'X' }),
      ).rejects.toThrow('composite-key');
      await expect(
        ds.update({ tenantId: 't1', userId: 7 }, { name: 'X' }),
      ).rejects.toThrow('prisma');
    });

    it('refuses composite delete by name with UnsupportedQueryFeatureError', async () => {
      await adapter.connect();
      const ds = adapter.createDataSourceForEntity('User');
      await expect(
        ds.delete({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow(UnsupportedQueryFeatureError);
      await expect(
        ds.delete({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow('composite-key');
      await expect(
        ds.delete({ tenantId: 't1', userId: 7 }),
      ).rejects.toThrow('prisma');
    });
  });

  describe('findPage — keyset cursor pagination (§3.8)', () => {
    /** Build the sort fingerprint in the format every minted cursor carries. */
    function fingerprintOf(orderBy: Record<string, string>): string {
      return Object.entries(orderBy).map(([field, dir]) => `${field}:${dir}`).join(',');
    }

    it('pages against the recorded arguments: take is limit+1 and no skip is sent', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'u1', createdAt: '2024-01-01' });
      await ds.create({ id: 'u2', createdAt: '2024-01-02' });
      await ds.create({ id: 'u3', createdAt: '2024-01-03' });

      const page = await ds.findPage!({
        where: {},
        orderBy: { createdAt: 'asc', id: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
      });

      // One findMany call, carrying limit + 1 (the one-extra-row probe) and
      // NO skip — the keyset position replaces offset (§3.10).
      const findManyCalls = fakeClient.recordedCalls.filter((c) => c.action === 'findMany');
      expect(findManyCalls.length).toBe(1);
      expect(findManyCalls[0]?.args).toEqual({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 3,
      });

      // The minted next cursor IS encodeCursor's output for the LAST returned
      // row's key values, carrying the resolved sort fingerprint.
      expect(page.rows.length).toBe(2);
      expect(page.nextCursor).toBe(
        encodeCursor({
          orderedValues: ['2024-01-02', 'u2'],
          keyValues: ['u2'],
          sortFingerprint: fingerprintOf({ createdAt: 'asc', id: 'asc' }),
        }),
      );
    });

    it('decodes the presented cursor into the keyset where via prismaFilter', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'u1', createdAt: '2024-01-01' });
      await ds.create({ id: 'u2', createdAt: '2024-01-02' });
      await ds.create({ id: 'u3', createdAt: '2024-01-03' });

      const p1 = await ds.findPage!({
        where: {},
        orderBy: { createdAt: 'asc', id: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
      });
      fakeClient.recordedCalls.length = 0;

      const p2 = await ds.findPage!({
        where: {},
        orderBy: { createdAt: 'asc', id: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
        cursor: p1.nextCursor!,
      });

      // The where is the decoded payload's keyset tree — or(lt, and(eq, gt)) —
      // translated through the existing prismaFilter path; its leaf values are
      // exactly the values the previous page minted into the token.
      const call = fakeClient.recordedCalls.find((c) => c.action === 'findMany');
      expect(call?.args.where).toEqual({
        OR: [
          { createdAt: { gt: '2024-01-02' } },
          { AND: [{ createdAt: '2024-01-02' }, { id: { gt: 'u2' } }] },
        ],
      });
      expect(call?.args.take).toBe(3);
      expect(p2.rows.map((r) => r.id)).toEqual(['u3']);
      expect(p2.nextCursor).toBeNull();
    });

    it('conjoins the keyset predicate with the caller where and filter', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'u1', name: 'Alice', role: 'admin' });
      await ds.create({ id: 'u2', name: 'Bob', role: 'user' });
      await ds.create({ id: 'u3', name: 'Carol', role: 'admin' });

      // A hand-minted cursor for the position after u2, so the recorded where
      // is assertable exactly.
      const cursor = encodeCursor({
        orderedValues: ['2024-01-02', 'u2'],
        keyValues: ['u2'],
        sortFingerprint: fingerprintOf({ createdAt: 'asc', id: 'asc' }),
      });

      await ds.findPage!({
        where: { role: 'admin' },
        filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'a' },
        orderBy: { createdAt: 'asc', id: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
        cursor,
      });

      const call = fakeClient.recordedCalls.find((c) => c.action === 'findMany');
      expect(call?.args.where).toEqual({
        AND: [
          { role: 'admin' },
          {
            AND: [
              { name: { contains: 'a' } },
              {
                OR: [
                  { createdAt: { gt: '2024-01-02' } },
                  { AND: [{ createdAt: '2024-01-02' }, { id: { gt: 'u2' } }] },
                ],
              },
            ],
          },
        ],
      });
    });

    it('pages with a caller filter alone on the first page (no cursor yet)', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'u1', name: 'Alice', role: 'admin' });
      await ds.create({ id: 'u2', name: 'Bob', role: 'user' });
      await ds.create({ id: 'u3', name: 'Carol', role: 'admin' });

      const page = await ds.findPage!({
        where: {},
        filter: { type: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
        orderBy: { name: 'asc' },
        limit: 1,
        offset: 0,
        select: [],
      });

      // No keyset predicate yet, so the where is the caller filter alone.
      const call = fakeClient.recordedCalls.find((c) => c.action === 'findMany');
      expect(call?.args.where).toEqual({ role: 'admin' });
      expect(call?.args.take).toBe(2);
      expect(page.rows.map((r) => r.name)).toEqual(['Alice']);
      expect(page.nextCursor).not.toBeNull();
    });

    it('walks a tied fixture across three pages with no row repeated or skipped (P10/P11)', async () => {
      // Deliberate sort-key ties: six rows over only two distinct createdAt
      // values, so the appended key tiebreaker is load-bearing — a naive
      // createdAt-only predicate silently loses rows (P11).
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'a', createdAt: '2024-01-01', name: '1' });
      await ds.create({ id: 'b', createdAt: '2024-01-01', name: '2' });
      await ds.create({ id: 'c', createdAt: '2024-01-01', name: '3' });
      await ds.create({ id: 'd', createdAt: '2024-01-02', name: '4' });
      await ds.create({ id: 'e', createdAt: '2024-01-02', name: '5' });
      await ds.create({ id: 'f', createdAt: '2024-01-02', name: '6' });

      const seenIds: string[] = [];
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
      const ds = adapter.createDataSource('User');
      await ds.create({ id: '1', score: 10 });
      await ds.create({ id: '2', score: 20 });
      await ds.create({ id: '3', score: 30 });

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

      // Mint a cursor under one sort ...
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

    it('refuses a non-zero offset beside a cursor at findPage (§3.10)', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: '1', name: 'Alice' });

      const cursor = encodeCursor({
        orderedValues: ['Alice'],
        keyValues: ['1'],
        sortFingerprint: fingerprintOf({ name: 'asc' }),
      });
      await expect(
        ds.findPage!({
          where: {},
          orderBy: { name: 'asc' },
          limit: 10,
          offset: 5,
          select: [],
          cursor,
        }),
      ).rejects.toThrow(PageNormalizationError);
      // Refused BEFORE any backend call.
      expect(fakeClient.recordedCalls.find((c) => c.action === 'findMany')).toBeUndefined();
    });

    it('adds key columns to the internal select and strips them from returned rows', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: 'u1', name: 'Alice', role: 'admin' });
      await ds.create({ id: 'u2', name: 'Bob', role: 'user' });
      await ds.create({ id: 'u3', name: 'Carol', role: 'admin' });

      const page = await ds.findPage!({
        where: {},
        orderBy: { name: 'asc' },
        limit: 2,
        offset: 0,
        select: ['role'],
      });

      // The internal select carries the caller's projection PLUS the key
      // column and the ordered field the cursor minting reads.
      const call = fakeClient.recordedCalls.find((c) => c.action === 'findMany');
      expect(call?.args.select).toEqual({ role: true, id: true, name: true });

      // The caller's projection is what comes back — key column stripped.
      expect(page.rows.length).toBe(2);
      expect(page.nextCursor).not.toBeNull();
      for (const row of page.rows) {
        expect('id' in row).toBe(false);
        expect('name' in row).toBe(false);
        expect(row).toHaveProperty('role');
      }

      // A cursor minted from a projected page still walks page two, stripped
      // too — the projection never leaks a key column.
      const p2 = await ds.findPage!({
        where: {},
        orderBy: { name: 'asc' },
        limit: 2,
        offset: 0,
        select: ['role'],
        cursor: page.nextCursor!,
      });
      expect(p2.rows.length).toBe(1);
      expect(p2.nextCursor).toBeNull();
      for (const row of p2.rows) {
        expect('id' in row).toBe(false);
        expect(row).toHaveProperty('role');
      }
    });

    it('serves findPage from the transaction data source — one shared implementation', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: '1', name: 'Alice' });
      await ds.create({ id: '2', name: 'Bob' });
      await ds.create({ id: '3', name: 'Carol' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      const p1 = await txDs.findPage!({
        where: {},
        orderBy: { name: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
      });
      expect(p1.rows.map((r) => r.name)).toEqual(['Alice', 'Bob']);
      expect(p1.nextCursor).not.toBeNull();

      const p2 = await txDs.findPage!({
        where: {},
        orderBy: { name: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
        cursor: p1.nextCursor!,
      });
      expect(p2.rows.map((r) => r.name)).toEqual(['Carol']);
      expect(p2.nextCursor).toBeNull();
      await txn.commit();
    });
  });
});

/**
 * Regression guards for the three Prisma key-handling defects found in the
 * M79 milestone review. Each one passed every gate, the per-file coverage bar
 * and both publish gates, and each fails without its fix.
 */
describe('Prisma key handling — M79 review regressions', () => {
  /** Records the `where` argument each delegate method receives. */
  function recordingClient(): { client: never; seen: Record<string, unknown>[] } {
    const seen: Record<string, unknown>[] = [];
    const delegate = {
      findUnique: (a: Record<string, unknown>) => {
        seen.push(a);
        return Promise.resolve(null);
      },
      update: (a: Record<string, unknown>) => {
        seen.push(a);
        return Promise.resolve({});
      },
      delete: (a: Record<string, unknown>) => {
        seen.push(a);
        return Promise.resolve({});
      },
      findMany: () => Promise.resolve([]),
      create: () => Promise.resolve({}),
      count: () => Promise.resolve(0),
    };
    return { client: { membership: delegate } as never, seen };
  }

  /**
   * A malformed composite key must REJECT, never throw synchronously. A
   * synchronous throw out of a `Promise`-typed method bypasses a caller using
   * `.catch()` — the M52b/M52c/M70j defect class. Before the fix `findById`
   * and `update` threw synchronously while `delete` rejected, so one adapter
   * disagreed with itself about how the same fault surfaces.
   */
  for (const method of ['findById', 'update', 'delete'] as const) {
    it(`rejects rather than throwing synchronously when the composite key is incomplete (${method})`, async () => {
      const { client } = recordingClient();
      const source = createSource(client);
      let threwSynchronously = false;
      let rejected = false;
      try {
        const call = method === 'update'
          ? source.update({ tenantId: 't1' }, { role: 'x' })
          : method === 'delete'
          ? source.delete({ tenantId: 't1' })
          : source.findById({ tenantId: 't1' });
        await call.catch(() => {
          rejected = true;
        });
      } catch {
        threwSynchronously = true;
      }
      expect(threwSynchronously).toBe(false);
      expect(rejected).toBe(true);
    });
  }

  /**
   * The refusal must name the method the caller invoked. `buildCompoundWhere`
   * hardcoded `findById` into every diagnostic, so an `update` failure sent
   * the reader to the wrong call site.
   */
  it('names the operation that actually failed, not always findById', async () => {
    const { client } = recordingClient();
    const source = createSource(client);
    await expect(source.update({ tenantId: 't1' }, { role: 'x' })).rejects.toThrow(/update on/);
    await expect(source.delete({ tenantId: 't1' })).rejects.toThrow(/delete on/);
    await expect(source.findById({ tenantId: 't1' })).rejects.toThrow(/findById on/);
  });

  /**
   * A single-column entity configured with a non-`id` key column must address
   * THAT column. The scalar path emitted a hardcoded `{ id }`, so a scalar
   * lookup silently queried the wrong column — a wrong row where the model
   * also has an `id`, and an unknown-field error where it does not.
   */
  it('addresses the configured key column on the scalar path, not a hardcoded id', async () => {
    const { client, seen } = recordingClient();
    const source = createPrismaDataSource(client, 'Membership', undefined, ['user_id'], undefined);
    await source.findById('u1');
    expect(seen[0]).toEqual({ where: { user_id: 'u1' } });
  });

  /** The default `['id']` keeps the pre-M79 shape byte-identical. */
  it('keeps the default single-column shape byte-identical to the pre-M79 path', async () => {
    const { client, seen } = recordingClient();
    const source = createPrismaDataSource(client, 'Membership');
    await source.findById('u1');
    expect(seen[0]).toEqual({ where: { id: 'u1' } });
  });

  /** Composite key wired end to end through the compound-key field. */
  function createSource(client: never): DataSource {
    return createPrismaDataSource(
      client,
      'Membership',
      undefined,
      ['tenantId', 'userId'],
      'tenantId_userId',
    );
  }
});
