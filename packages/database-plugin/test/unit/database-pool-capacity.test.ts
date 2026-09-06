/**
 * Pool-capacity seam (M90b): the internal adapter→plugin bridge, the
 * snapshot type guard, and the indicator data it publishes.
 *
 * Driven through the `type: 'custom'` arm because that is exactly how the
 * plugin consumes the seam — it feature-detects the symbol on ANY
 * `IDatabaseAdapter` value, so a fake carrying the member is the honest
 * stand-in, and a fake without one pins the "no fields" arm.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IAdapterTransaction,
  IDatabaseAdapter,
  IDataSource,
  IPluginContext,
} from '@setu-ts/common';

import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import {
  DATABASE_POOL_CAPACITY,
  isDatabasePoolCapacity,
  readPoolCapacity,
} from '../../src/health/database-capacity.ts';
import type { DatabasePoolCapacity, DrizzleAdapterOptions } from '../../src/interfaces/index.ts';

/** A minimal backend carrying (or not carrying) the capacity seam. */
class FakeAdapter implements IDatabaseAdapter {
  #ready = false;

  constructor(capacity?: (() => unknown) | undefined) {
    if (capacity !== undefined) {
      this[DATABASE_POOL_CAPACITY] = capacity as () => DatabasePoolCapacity;
    }
  }

  connect(): Promise<void> {
    this.#ready = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#ready = false;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#ready;
  }

  createDataSource(_entity: string): IDataSource {
    return emptySource();
  }

  beginTransaction(): Promise<IAdapterTransaction> {
    return Promise.resolve({
      createDataSource: () => emptySource(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    });
  }

  rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]> {
    void sql;
    void params;
    return Promise.resolve([]);
  }

  [DATABASE_POOL_CAPACITY]?: () => DatabasePoolCapacity;
}

function emptySource(): IDataSource {
  return {
    findAll: () => Promise.resolve([]),
    findById: () => Promise.resolve(null),
    create: (data) => Promise.resolve({ ...data } as Record<string, unknown>),
    update: (_id, data) => Promise.resolve({ ...data } as Record<string, unknown>),
    delete: () => Promise.resolve(true),
    count: () => Promise.resolve(0),
  };
}

/** Registers the plugin and returns the indicator it registered. */
async function registerIndicator(adapter: IDatabaseAdapter): Promise<{
  indicator: () => Promise<{ status: string; data?: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  const healthChecks = new Map<
    string,
    () => Promise<{ status: string; data?: Record<string, unknown> }>
  >();
  const closeHandlers: Array<() => Promise<void>> = [];
  const registered = new Map<string, unknown>();
  const ctx = {
    services: {
      has: () => false,
      get: () => undefined,
      register: (token: string, service: unknown) => {
        registered.set(token, service);
      },
    },
    health: {
      register: (
        name: string,
        fn: () => Promise<{ status: string; data?: Record<string, unknown> }>,
      ) => {
        healthChecks.set(name, fn);
      },
    },
    lifecycle: {
      onClose: (fn: () => Promise<void>) => {
        closeHandlers.push(fn);
      },
    },
    runtime: {
      hrtime: () => 0,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  } as unknown as IPluginContext;

  const plugin = DatabasePlugin({ type: 'custom', adapter });
  await plugin.register(ctx);
  const indicator = healthChecks.get('database')!;
  return {
    indicator: () => indicator(),
    close: () => closeHandlers[0](),
  };
}

describe('isDatabasePoolCapacity guard (M90b)', () => {
  it('accepts a well-formed snapshot', () => {
    expect(isDatabasePoolCapacity({ total: 10, idle: 4, waiting: 0 })).toBe(true);
  });

  it('rejects non-objects and partial or non-numeric snapshots', () => {
    expect(isDatabasePoolCapacity(null)).toBe(false);
    expect(isDatabasePoolCapacity('10/4/0')).toBe(false);
    expect(isDatabasePoolCapacity({ total: 10, idle: 4 })).toBe(false);
    expect(isDatabasePoolCapacity({ total: 10, idle: 4, waiting: NaN })).toBe(false);
    expect(isDatabasePoolCapacity({ total: Infinity, idle: 4, waiting: 0 })).toBe(false);
    expect(isDatabasePoolCapacity({ total: '10', idle: 4, waiting: 0 })).toBe(false);
  });

  it('rejects counters that violate the documented relationships', () => {
    // `total` counts idle + in use, so idle cannot exceed it.
    expect(isDatabasePoolCapacity({ total: 10, idle: 11, waiting: 0 })).toBe(false);
    // Counts cannot be negative.
    expect(isDatabasePoolCapacity({ total: -1, idle: 0, waiting: 0 })).toBe(false);
    expect(isDatabasePoolCapacity({ total: 10, idle: -1, waiting: 0 })).toBe(false);
    expect(isDatabasePoolCapacity({ total: 10, idle: 4, waiting: -1 })).toBe(false);
  });
});

describe('readPoolCapacity seam (M90b)', () => {
  it('reads a valid snapshot from an adapter exposing the seam', () => {
    const adapter = new FakeAdapter(() => ({ total: 10, idle: 4, waiting: 0 }));
    expect(readPoolCapacity(adapter)).toEqual({ total: 10, idle: 4, waiting: 0 });
  });

  it('returns undefined for an adapter without the seam', () => {
    expect(readPoolCapacity(new FakeAdapter(undefined))).toBeUndefined();
  });

  it('returns undefined when the reader returns a malformed snapshot', () => {
    const adapter = new FakeAdapter(() => ({ total: 10 }));
    expect(readPoolCapacity(adapter)).toBeUndefined();
  });

  it('returns undefined when the reader throws — capacity is data, not a fault', () => {
    const adapter = new FakeAdapter(() => {
      throw new Error('pool is closed');
    });
    expect(readPoolCapacity(adapter)).toBeUndefined();
  });
});

describe('DrizzleAdapter seam attachment (M90b)', () => {
  it('attaches the reader only when poolStats is configured', () => {
    const withPool: DrizzleAdapterOptions = {
      drizzleInstance: {} as never,
      drizzleTables: {},
      poolStats: () => ({ total: 1, idle: 0, waiting: 0 }),
    };
    expect(readPoolCapacity(new DrizzleAdapter(withPool))).toEqual({
      total: 1,
      idle: 0,
      waiting: 0,
    });

    const withoutPool: DrizzleAdapterOptions = {
      drizzleInstance: {} as never,
      drizzleTables: {},
    };
    expect(readPoolCapacity(new DrizzleAdapter(withoutPool))).toBeUndefined();
  });
});

describe('database indicator capacity data (M90b)', () => {
  it('publishes the application-supplied snapshot and stays up while connected', async () => {
    const adapter = new FakeAdapter(() => ({ total: 12, idle: 3, waiting: 7 }));
    const { indicator } = await registerIndicator(adapter);
    const health = await indicator();
    expect(health.status).toBe('up');
    expect(health.data).toEqual({
      adapter: 'custom',
      name: 'default',
      capacity: { total: 12, idle: 3, waiting: 7 },
    });
  });

  it('carries no capacity fields when the adapter has no seam', async () => {
    const { indicator } = await registerIndicator(new FakeAdapter(undefined));
    const health = await indicator();
    expect(health.status).toBe('up');
    expect(health.data).toEqual({ adapter: 'custom', name: 'default' });
  });

  it('drops a malformed snapshot exactly like an absent one', async () => {
    const adapter = new FakeAdapter(() => ({ total: 12, idle: 'three', waiting: 7 }));
    const { indicator } = await registerIndicator(adapter);
    const health = await indicator();
    expect(health.status).toBe('up');
    expect(health.data).toEqual({ adapter: 'custom', name: 'default' });
  });

  it('a throwing poolStats callback never rejects the indicator', async () => {
    const adapter = new FakeAdapter(() => {
      throw new Error('pool accessor exploded');
    });
    const { indicator } = await registerIndicator(adapter);
    const health = await indicator();
    // The indicator's own lifecycle answer stands; no capacity fields ship.
    expect(health.status).toBe('up');
    expect(health.data).toEqual({ adapter: 'custom', name: 'default' });
  });

  it('drops a snapshot whose counters violate the documented shape', async () => {
    const adapter = new FakeAdapter(() => ({ total: 12, idle: 13, waiting: 0 }));
    const { indicator } = await registerIndicator(adapter);
    const health = await indicator();
    expect(health.status).toBe('up');
    expect(health.data).toEqual({ adapter: 'custom', name: 'default' });
  });

  it('reads down after close — the lifecycle gate is uncached', async () => {
    const adapter = new FakeAdapter(() => ({ total: 12, idle: 3, waiting: 7 }));
    const { indicator, close } = await registerIndicator(adapter);
    expect((await indicator()).status).toBe('up');
    await close();
    expect((await indicator()).status).toBe('down');
    expect((await indicator()).data).toEqual({
      adapter: 'custom',
      name: 'default',
      capacity: { total: 12, idle: 3, waiting: 7 },
    });
  });
});
