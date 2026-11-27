import { describe, expect, it } from 'vitest';
import {
  createDrizzleDatabase,
  DrizzleAdapter,
  getDrizzleDatabase,
  DatabaseService,
} from '../../src/index.ts';
import {
  readPoolCapacity,
  readQueryProgress,
  probeHitAcquireTimeout,
} from '../../src/health/database-capacity.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';

describe('default Drizzle pool statistics', () => {
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
