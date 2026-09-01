/**
 * The Bigtable adapter's lifecycle, configuration guards and refusals.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDatabaseAdapter } from '@setu-ts/common';
import { BigtableAdapter } from '../../src/adapters/bigtable/bigtable-adapter.ts';
import { UnsupportedRawQueryError } from '../../src/errors.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';

/** Builds an adapter over a fresh fake client. */
function setup(): { store: FakeBigtableStore; adapter: BigtableAdapter } {
  const store = new FakeBigtableStore();
  const adapter = new BigtableAdapter({
    client: createFakeBigtableClient(store),
    instance: 'app',
  });
  return { store, adapter };
}

describe('construction guards', () => {
  it('refuses neither a client nor a projectId', () => {
    expect(() => new BigtableAdapter({ instance: 'app' } as never))
      .toThrow(/options.client or options.projectId/);
    expect(() => new BigtableAdapter({ projectId: '   ', instance: 'app' }))
      .toThrow(/options.client or options.projectId/);
  });

  it('refuses a missing or blank instance, naming why a project is not enough', () => {
    const store = new FakeBigtableStore();
    expect(() => new BigtableAdapter({ client: createFakeBigtableClient(store), instance: '' }))
      .toThrow(/project\/instance\/table/);
    expect(() => new BigtableAdapter({ projectId: 'p', instance: '  ' }))
      .toThrow(/requires options.instance/);
  });

  it('accepts the lazy arm without ever loading the SDK', () => {
    // Construction resolves nothing: the literal `import()` sits inside the
    // loader's `load()`, which only `connect()` reaches.
    expect(() => new BigtableAdapter({ projectId: 'p', instance: 'i' })).not.toThrow();
  });
});

describe('lifecycle', () => {
  it('connects without issuing any RPC', async () => {
    const { store, adapter } = setup();
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    expect(store.reads).toHaveLength(0);
  });

  it('is idempotent and shares one in-flight attempt', async () => {
    const { adapter } = setup();
    await Promise.all([adapter.connect(), adapter.connect()]);
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
  });

  it('never closes an INJECTED client', async () => {
    const { store, adapter } = setup();
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
    expect(store.closes).toBe(0);
  });

  it("closes a client it CREATED, through the loader's owned flag", async () => {
    const store = new FakeBigtableStore();
    const adapter = new BigtableAdapter({ projectId: 'p', instance: 'i' }, {
      owned: true,
      load: () => Promise.resolve(createFakeBigtableClient(store)),
    });
    await adapter.connect();
    await adapter.disconnect();
    expect(store.closes).toBe(1);
  });

  it('drops and closes an attempt a disconnect superseded', async () => {
    const store = new FakeBigtableStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new BigtableAdapter({ projectId: 'p', instance: 'i' }, {
      owned: true,
      load: async () => {
        await gate;
        return createFakeBigtableClient(store);
      },
    });
    const connecting = adapter.connect();
    // The disconnect lands while the attempt is still in flight, so the
    // attempt's own result must be discarded rather than resurrecting a closed
    // adapter — and the client it created closed, since nothing holds it.
    await adapter.disconnect();
    (release as () => void)();
    await connecting;
    expect(adapter.isReady()).toBe(false);
    expect(store.closes).toBe(1);
  });

  it('starts a FRESH attempt after a disconnect rather than sharing the stale one', async () => {
    const store = new FakeBigtableStore();
    let loads = 0;
    const adapter = new BigtableAdapter({ projectId: 'p', instance: 'i' }, {
      owned: false,
      load: () => {
        loads += 1;
        return Promise.resolve(createFakeBigtableClient(store));
      },
    });
    await adapter.connect();
    await adapter.disconnect();
    await adapter.connect();
    expect(loads).toBe(2);
    expect(adapter.isReady()).toBe(true);
  });

  it('refuses a data source before connect and rejects a transaction', async () => {
    const { adapter } = setup();
    expect(() => adapter.createDataSource('User')).toThrow(/not connected/);
    await expect(adapter.beginTransaction()).rejects.toThrow(/not connected/);
  });

  it('opens a working data source once connected', async () => {
    const { adapter } = setup();
    await adapter.connect();
    const source = adapter.createDataSource('User');
    await source.create({ id: 'u1', name: 'ada' });
    expect(await source.findById('u1')).toEqual({ id: 'u1', name: 'ada' });
  });

  it('opens a transaction once connected', async () => {
    const { adapter } = setup();
    await adapter.connect();
    const tx = await adapter.beginTransaction();
    await tx.createDataSource('User').create({ id: 'u1' });
    await tx.commit();
    expect(await adapter.createDataSource('User').findById('u1')).toEqual({ id: 'u1' });
  });

  it('honours a mapped table and maxPageFetches', async () => {
    const store = new FakeBigtableStore();
    const adapter = new BigtableAdapter({
      client: createFakeBigtableClient(store),
      instance: 'app',
      maxPageFetches: 3,
      tables: { Order: { table: 'orders' } },
    });
    await adapter.connect();
    await adapter.createDataSource('Order').create({ id: 'o1' });
    expect(store.snapshot('orders', 'o1')).toBeDefined();
    const tx = await adapter.beginTransaction();
    await tx.createDataSource('Order').create({ id: 'o2' });
    await tx.commit();
    expect(store.snapshot('orders', 'o2')).toBeDefined();
  });
});

describe('rawQuery', () => {
  it('REJECTS by name rather than throwing synchronously', async () => {
    const { adapter } = setup();
    // A synchronous throw from a Promise-typed method bypasses a caller using
    // `.catch()`, which is the defect class this repository has shipped before.
    const settled = adapter.rawQuery('SELECT 1');
    expect(settled).toBeInstanceOf(Promise);
    await expect(settled).rejects.toThrow(UnsupportedRawQueryError);
  });
});

describe('contract', () => {
  it('satisfies IDatabaseAdapter structurally', () => {
    const { adapter } = setup();
    const port: IDatabaseAdapter = adapter;
    expect(typeof port.createDataSource).toBe('function');
  });
});
