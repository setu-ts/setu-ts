/**
 * The Bigtable adapter's lifecycle, configuration guards and refusals.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IDatabaseAdapter } from '@setu-ts/common';
import type {
  BigtableReadOptions,
  IBigtableClient,
} from '../../src/adapters/bigtable/bigtable-client-types.ts';
import type { BigtableAdapterOptions } from '../../src/interfaces/index.ts';
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
    expect(() => new BigtableAdapter({ instance: 'app' } as never)).toThrow(
      /options.client or options.projectId/,
    );
    expect(() => new BigtableAdapter({ projectId: '   ', instance: 'app' })).toThrow(
      /options.client or options.projectId/,
    );
  });

  it('refuses a missing or blank instance, naming why a project is not enough', () => {
    const store = new FakeBigtableStore();
    expect(
      () => new BigtableAdapter({ client: createFakeBigtableClient(store), instance: '' }),
    ).toThrow(/project\/instance\/table/);
    expect(() => new BigtableAdapter({ projectId: 'p', instance: '  ' })).toThrow(
      /requires options.instance/,
    );
  });

  it('refuses a maxPageFetches that would disable the page loop', () => {
    const store = new FakeBigtableStore();
    for (const maxPageFetches of [0, -1, Number.NaN, 1.5]) {
      expect(
        () =>
          new BigtableAdapter({
            client: createFakeBigtableClient(store),
            instance: 'app',
            maxPageFetches,
          }),
        `maxPageFetches=${String(maxPageFetches)}`,
      ).toThrow(/positive integer/);
    }
    expect(
      () =>
        new BigtableAdapter({
          client: createFakeBigtableClient(store),
          instance: 'app',
          maxPageFetches: 1,
        }),
    ).not.toThrow();
  });

  it('accepts the lazy arm without ever loading the SDK', () => {
    // Construction resolves nothing: the literal `import()` sits inside the
    // loader's `load()`, which only `connect()` reaches.
    expect(() => new BigtableAdapter({ projectId: 'p', instance: 'i' })).not.toThrow();
  });
});

describe('lifecycle', () => {
  it('connects with exactly one warm-up read and nothing else', async () => {
    const { store, adapter } = setup();
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    expect(store.reads).toEqual([
      {
        table: '__setu_readiness__',
        options: { keys: ['__setu_readiness__'], filter: { column: { cellLimit: 1 } } },
      },
    ]);
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
    const adapter = new BigtableAdapter(
      { projectId: 'p', instance: 'i' },
      {
        owned: true,
        load: () => Promise.resolve(createFakeBigtableClient(store)),
      },
    );
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
    const adapter = new BigtableAdapter(
      { projectId: 'p', instance: 'i' },
      {
        owned: true,
        load: async () => {
          await gate;
          return createFakeBigtableClient(store);
        },
      },
    );
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
    const adapter = new BigtableAdapter(
      { projectId: 'p', instance: 'i' },
      {
        owned: false,
        load: () => {
          loads += 1;
          return Promise.resolve(createFakeBigtableClient(store));
        },
      },
    );
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

it('refuses an absent instance from untyped input and accepts an explicit transaction page budget', async () => {
  const client = createFakeBigtableClient(new FakeBigtableStore());
  expect(
    () =>
      new BigtableAdapter({ client } as unknown as ConstructorParameters<
        typeof BigtableAdapter
      >[0]),
  ).toThrow(/requires options.instance/);
  const adapter = new BigtableAdapter({ client, instance: 'i', maxPageFetches: 2 });
  await adapter.connect();
  const transaction = await adapter.beginTransaction();
  await transaction.rollback();
  await adapter.disconnect();
});

/** One warm-up read as the client saw it. */
interface WarmRead {
  readonly table: string;
  readonly options: BigtableReadOptions;
  readonly timeoutMs: number | undefined;
}

/** Wraps the fake client so every read records its table and call options; `fail` makes reads reject. */
function warmClient(fail?: Error): { client: IBigtableClient; reads: WarmRead[] } {
  const inner = createFakeBigtableClient(new FakeBigtableStore());
  const reads: WarmRead[] = [];
  const client: IBigtableClient = {
    instance: (id) => {
      const instance = inner.instance(id);
      return {
        table: (table) => {
          const handle = instance.table(table);
          return {
            row: (key) => handle.row(key),
            readRows: (options, callOptions) => {
              reads.push({ table, options, timeoutMs: callOptions?.timeoutMs });
              return fail === undefined
                ? handle.readRows(options, callOptions)
                : Promise.reject(fail);
            },
          };
        },
      };
    },
    close: () => inner.close(),
  };
  return { client, reads };
}

describe('connect warm-up', () => {
  const timeouts: readonly { readonly requestTimeoutMs?: number; readonly bound: number }[] = [
    { bound: 2000 },
    { requestTimeoutMs: 500, bound: 500 },
    { requestTimeoutMs: 1500.5, bound: 1500.5 },
    { requestTimeoutMs: 60_000, bound: 2000 },
    { requestTimeoutMs: 0, bound: 2000 },
  ];
  for (const row of timeouts) {
    it(`is bounded by ${row.bound} ms when requestTimeoutMs is ${String(row.requestTimeoutMs)}`, async () => {
      const { client, reads } = warmClient();
      const adapter = new BigtableAdapter({
        client,
        instance: 'app',
        ...(row.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: row.requestTimeoutMs }),
      });
      await adapter.connect();
      expect(reads.map((read) => read.timeoutMs)).toEqual([row.bound]);
      await adapter.disconnect();
    });
  }

  const targets: readonly {
    readonly name: string;
    readonly options: Partial<BigtableAdapterOptions>;
    readonly table: string;
  }[] = [
    { name: 'a fixed table with no mapping', options: {}, table: '__setu_readiness__' },
    {
      name: 'the first mapped table',
      options: { tables: { Order: { table: 'orders' }, User: { table: 'users' } } },
      table: 'orders',
    },
    {
      name: "the readiness entity's table",
      options: {
        tables: { Order: { table: 'orders' }, User: { table: 'users' } },
        readinessEntity: 'User',
      },
      table: 'users',
    },
  ];
  for (const target of targets) {
    it(`reads a sentinel row of ${target.name}`, async () => {
      const { client, reads } = warmClient();
      const adapter = new BigtableAdapter({ client, instance: 'app', ...target.options });
      await adapter.connect();
      expect(reads).toEqual([
        {
          table: target.table,
          options: { keys: ['__setu_readiness__'], filter: { column: { cellLimit: 1 } } },
          timeoutMs: 2000,
        },
      ]);
      await adapter.disconnect();
    });
  }

  it('warms once across repeated and concurrent connects', async () => {
    const { client, reads } = warmClient();
    const adapter = new BigtableAdapter({ client, instance: 'app' });
    await Promise.all([adapter.connect(), adapter.connect()]);
    await adapter.connect();
    expect(reads).toHaveLength(1);
    await adapter.disconnect();
  });

  it('ignores a failed warm-up: connect resolves and the adapter is ready', async () => {
    const { client, reads } = warmClient(Object.assign(new Error('table not found'), { code: 5 }));
    const adapter = new BigtableAdapter({ client, instance: 'app' });
    await adapter.connect();
    expect(reads).toHaveLength(1);
    expect(adapter.isReady()).toBe(true);
    await adapter.disconnect();
  });

  it('ignores a warm-up target the mapping cannot resolve, leaving the error to the call that uses it', async () => {
    const { client, reads } = warmClient();
    const adapter = new BigtableAdapter({
      client,
      instance: 'app',
      tables: { Bad: { rowKey: { fields: [] } } },
    });
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    expect(reads).toEqual([]);
    expect(() => adapter.createDataSource('Bad')).toThrow(/empty 'rowKey.fields'/);
    await adapter.disconnect();
  });

  it('drops an attempt whose disconnect landed during the warm-up', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new FakeBigtableStore();
    const inner = createFakeBigtableClient(store);
    let warming = false;
    const client: IBigtableClient = {
      instance: (id) => ({
        table: (table) => ({
          row: (key) => inner.instance(id).table(table).row(key),
          readRows: async (options, callOptions) => {
            warming = true;
            await gate;
            return await inner.instance(id).table(table).readRows(options, callOptions);
          },
        }),
      }),
      close: () => inner.close(),
    };
    const adapter = new BigtableAdapter(
      { projectId: 'p', instance: 'i' },
      { owned: true, load: () => Promise.resolve(client) },
    );
    const connecting = adapter.connect();
    for (let tick = 0; tick < 50 && !warming; tick += 1) await Promise.resolve();
    // The disconnect lands while the warm-up itself is in flight.
    expect(warming).toBe(true);
    await adapter.disconnect();
    (release as () => void)();
    await connecting;
    expect(adapter.isReady()).toBe(false);
    expect(store.closes).toBe(1);
  });
});
