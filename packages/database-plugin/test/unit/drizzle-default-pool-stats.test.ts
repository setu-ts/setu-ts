import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { DatabasePlugin } from '../../src/index.ts';
import type { IDatabaseService } from '../../src/index.ts';
import { observePoolReleases } from '../../src/health/pool-progress.ts';
import {
  createDrizzleDatabase,
  DrizzleAdapter,
  getDrizzleDatabase,
  DatabaseService,
} from '../../src/index.ts';
import {
  DATABASE_QUERY_PROGRESS,
  readPoolCapacity,
  readQueryProgress,
  probeHitAcquireTimeout,
} from '../../src/health/database-capacity.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';

describe('default Drizzle pool statistics', () => {
  for (const explicit of [false, true]) {
    it(`pool releases keep native traffic observable through busy and hung readiness (explicit ${explicit})`, async () => {
      const pool = Object.assign(new EventEmitter(), {
        totalCount: 2,
        idleCount: 0,
        waitingCount: 1,
      });
      const native = Object.assign(createFakeDrizzleInstance(), { $client: pool });
      const configured = createDrizzleDatabase(native, (db, work) => db.transaction(work));
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          DatabasePlugin({
            type: 'drizzle',
            options: {
              drizzleInstance: configured,
              drizzleTables: { Item: createFakeDrizzleTable('Item') },
              ...(explicit ? { poolStats: () => ({ total: 9, idle: 0, waiting: 1 }) } : {}),
            },
          }),
          HealthPlugin({ details: true }),
        ],
      });
      await app.start();
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      let now = 0;
      const clock = vi.spyOn(runtime, 'hrtime').mockImplementation(() => now);
      try {
        getDrizzleDatabase(app.services.get<IDatabaseService>(CAPABILITIES.DATABASE), configured);
        pool.emit('release', undefined, {});
        expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
        now = 10_001;
        expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
        const hung = (await app.inject({ method: 'GET', url: '/health' })).json<{
          checks: { database: { status: string } };
        }>();
        expect(hung.checks.database.status).toBe('degraded');
        // A repository call on pg-pool releases its client like a native
        // query; the fake pool emits that release by hand.
        await app.services
          .get<IDatabaseService>(CAPABILITIES.DATABASE)
          .getRepository('Item')
          .findAll();
        pool.emit('release', undefined, {});
        expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
        now = 20_002;
        expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
        pool.emit('release', undefined, {});
        const busy = (await app.inject({ method: 'GET', url: '/health' })).json<{
          checks: {
            database: { status: string; data: { reachable: string; capacity: { total: number } } };
          };
        }>();
        expect(busy.checks.database.status).toBe('up');
        expect(busy.checks.database.data.reachable).toBe('unknown');
        expect(busy.checks.database.data.capacity.total).toBe(explicit ? 9 : 2);
        expect(pool.listenerCount('release')).toBe(2);
      } finally {
        clock.mockRestore();
        await app.stop();
      }
      expect(pool.listenerCount('release')).toBe(1);
    });
  }
  it('release observation ignores non-pg clients and restores the original progress seam', () => {
    const adapter = new DrizzleAdapter();
    for (const database of [
      null,
      1,
      {},
      { $client: null },
      { $client: {} },
      { $client: { totalCount: 1 } },
      { $client: { totalCount: 1, idleCount: 0 } },
      { $client: { totalCount: 1, idleCount: 0, waitingCount: 1 } },
      { $client: { totalCount: 1, idleCount: 0, waitingCount: 1, on() {} } },
    ]) {
      expect(observePoolReleases(database, adapter)).toBeUndefined();
    }
    const pool = Object.assign(new EventEmitter(), {
      totalCount: 1,
      idleCount: 0,
      waitingCount: 1,
    });
    const stop = observePoolReleases({ $client: pool }, adapter)!;
    expect(readQueryProgress(adapter)).toBe(0);
    pool.emit('release');
    expect(readQueryProgress(adapter)).toBe(1);
    // A failed query or a broken client releases with an error: not progress.
    pool.emit('release', new Error('Query read timeout'), {});
    expect(readQueryProgress(adapter)).toBe(1);
    pool.emit('release', null, {});
    expect(readQueryProgress(adapter)).toBe(2);
    stop();
    expect(readQueryProgress(adapter)).toBeUndefined();
    expect(pool.listenerCount('release')).toBe(0);
  });
  it('release counting carries progress once the adapter reports native traffic unobservable', () => {
    const adapter = new DrizzleAdapter();
    let own: number | null = 3;
    (adapter as unknown as Record<symbol, unknown>)[DATABASE_QUERY_PROGRESS] = () => own;
    const pool = Object.assign(new EventEmitter(), {
      totalCount: 1,
      idleCount: 0,
      waitingCount: 1,
    });
    const stop = observePoolReleases({ $client: pool }, adapter)!;
    expect(readQueryProgress(adapter)).toBe(3);
    own = null;
    expect(readQueryProgress(adapter)).toBe(0);
    pool.emit('release', undefined, {});
    expect(readQueryProgress(adapter)).toBe(1);
    stop();
    expect(readQueryProgress(adapter)).toBe('unobservable');
  });
  it('an unreadable counter leaves capacity inference absent', async () => {
    const client = {
      get totalCount(): never {
        throw new Error('closed');
      },
      idleCount: 1,
      waitingCount: 0,
    };
    const native = Object.assign(createFakeDrizzleInstance(), { $client: client });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(native, (db, work) => db.transaction(work)),
      drizzleTables: { Item: createFakeDrizzleTable('Item') },
    });
    await adapter.connect();
    try {
      expect(readPoolCapacity(adapter)).toBeUndefined();
    } finally {
      await adapter.disconnect();
    }
  });
  it('reads live pg counters and attaches capacity, progress and acquire-timeout seams', async () => {
    const client = { totalCount: 2, idleCount: 1, waitingCount: 0 };
    const native = Object.assign(createFakeDrizzleInstance(), { $client: client });
    const configured = createDrizzleDatabase(native, (db, work) => db.transaction(work));
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Item: createFakeDrizzleTable('Item') },
    });
    await adapter.connect();
    try {
      expect(readPoolCapacity(adapter)).toEqual({ total: 2, idle: 1, waiting: 0 });
      client.idleCount = 0;
      client.waitingCount = 2;
      expect(readPoolCapacity(adapter)).toEqual({ total: 2, idle: 0, waiting: 2 });
      expect(readQueryProgress(adapter)).toBe(0);
      expect(probeHitAcquireTimeout(adapter)).toBe(false);
      await adapter.rawQuery('select 1');
      expect(readQueryProgress(adapter)).toBe(1);
      const db = new DatabaseService(
        adapter,
        () => {
          throw new Error('unused');
        },
        'drizzle',
      );
      getDrizzleDatabase(db, configured);
      // The adapter alone cannot see native traffic; the plugin's release
      // observer is what makes it observable again.
      expect(readQueryProgress(adapter)).toBe('unobservable');
    } finally {
      await adapter.disconnect();
    }
  });
  it('an explicit callback wins over pg counters', async () => {
    const native = Object.assign(createFakeDrizzleInstance(), {
      $client: { totalCount: 2, idleCount: 1, waitingCount: 0 },
    });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(native, (db, work) => db.transaction(work)),
      drizzleTables: { Item: createFakeDrizzleTable('Item') },
      poolStats: () => ({ total: 9, idle: 4, waiting: 1 }),
    });
    await adapter.connect();
    try {
      expect(readPoolCapacity(adapter)).toEqual({ total: 9, idle: 4, waiting: 1 });
    } finally {
      await adapter.disconnect();
    }
  });
  for (const client of [
    undefined,
    null,
    {},
    { totalCount: '2', idleCount: 1, waitingCount: 0 },
    { totalCount: 2, idleCount: '1', waitingCount: 0 },
    { totalCount: 2, idleCount: 1, waitingCount: '0' },
  ]) {
    it(`does not infer counters from ${JSON.stringify(client)}`, async () => {
      const native = Object.assign(createFakeDrizzleInstance(), { $client: client });
      const adapter = new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(native, (db, work) => db.transaction(work)),
        drizzleTables: { Item: createFakeDrizzleTable('Item') },
      });
      await adapter.connect();
      try {
        expect(readPoolCapacity(adapter)).toBeUndefined();
        expect(readQueryProgress(adapter)).toBeUndefined();
        expect(probeHitAcquireTimeout(adapter)).toBe(false);
      } finally {
        await adapter.disconnect();
      }
    });
  }
});
