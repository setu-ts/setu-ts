// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
/**
 * Coverage for {@linkcode DynamoAdapter} lifecycle, construction validation,
 * per-entity data sources, and the raw-query refusal.
 *
 * Drives the adapter through an injected {@linkcode IDynamoClient} — no
 * server — asserting the documented contract: `isReady()` reports the resolved
 * client without I/O, an injected client missing the driven surface fails at
 * construction **by name** (the M52c/M52d binding-guard precedent), and
 * `rawQuery` **rejects** (never throws synchronously) with
 * {@linkcode UnsupportedRawQueryError}. The lazy arm is driven through the
 * real `npm:@aws-sdk/client-dynamodb` import — the SDK constructs a client
 * without touching the network, so no emulator is needed.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DynamoAdapter } from '../../src/adapters/dynamo/dynamo-adapter.ts';
import type { DynamoAdapterOptions } from '../../src/interfaces/index.ts';
import { UnsupportedRawQueryError } from '../../src/errors.ts';
import type {
  DynamoTransactWriteItemsCommandInput,
  IDynamoClient,
} from '../../src/adapters/dynamo/dynamo-client-types.ts';

/** A spy client exposing the full driven surface plus the calls it recorded. */
interface SpyClient extends IDynamoClient {
  transactCalls: DynamoTransactWriteItemsCommandInput[];
  destroyed: number;
}

/** Builds a spy client; individual members are replaced via `overrides`. */
function fakeClient(overrides: Partial<IDynamoClient> = {}): SpyClient {
  const client: SpyClient = {
    transactCalls: [],
    destroyed: 0,
    query: async () => ({}),
    scan: async () => ({}),
    getItem: async () => ({}),
    putItem: async () => ({}),
    updateItem: async () => ({}),
    deleteItem: async () => ({}),
    transactWriteItems: async (input) => {
      client.transactCalls.push(input);
      return {};
    },
    destroy: () => {
      client.destroyed += 1;
    },
  };
  return Object.assign(client, overrides);
}

describe('DynamoAdapter — lifecycle against an injected client', () => {
  it('is not ready before connect, ready after, and not ready after disconnect', async () => {
    const adapter = new DynamoAdapter({ client: fakeClient() });
    expect(adapter.isReady()).toBe(false);
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
  });

  it('serves a per-entity data source over the injected client and its mapping', async () => {
    const client = fakeClient({
      getItem: async () => ({ Item: { pk: { S: 'a' }, name: { S: 'Bolt' } } }),
    });
    const adapter = new DynamoAdapter({
      client,
      entities: { Widget: { partitionKey: 'pk' } },
    });
    await adapter.connect();
    const ds = adapter.createDataSource('Widget');
    // The scalar key was marshalled under the entity's mapped partition key,
    // proving the adapter forwarded `entities` to the data source.
    expect(await ds.findById('a')).toEqual({ pk: 'a', name: 'Bolt' });
  });

  it('forwards the configured page-fetch bound to findPage', async () => {
    let scans = 0;
    const client = fakeClient({
      scan: async () => {
        scans += 1;
        return { Items: [], LastEvaluatedKey: { pk: { S: 'cursor' } } };
      },
    });
    const adapter = new DynamoAdapter({
      client,
      entities: { Widget: { partitionKey: 'pk' } },
      maxPageFetches: 2,
    });
    await adapter.connect();
    const ds = adapter.createDataSource('Widget');
    if (ds.findPage === undefined) throw new Error('findPage must be served');
    const page = await ds.findPage({
      where: {},
      orderBy: {},
      limit: 5,
      offset: 0,
      select: [],
    });
    // Every page came back empty with a continuation key, so the fill loop ran
    // exactly to the configured bound and returned a non-terminal page.
    expect(scans).toBe(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it('connects idempotently — the second connect() performs no new work', async () => {
    const client = fakeClient();
    const adapter = new DynamoAdapter({ client });
    await adapter.connect();
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
  });

  it('concurrent callers share one attempt instead of each running the sequence', async () => {
    const client = fakeClient();
    const adapter = new DynamoAdapter({ client });
    await Promise.all([adapter.connect(), adapter.connect(), adapter.connect()]);
    expect(adapter.isReady()).toBe(true);
  });

  it('disconnect never destroys an injected client the application owns', async () => {
    const client = fakeClient();
    const adapter = new DynamoAdapter({ client });
    await adapter.connect();
    await adapter.disconnect();
    expect(client.destroyed).toBe(0);
  });

  it('disconnects cleanly when it was never connected', async () => {
    const adapter = new DynamoAdapter({ client: fakeClient() });
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
  });

  it('refuses createDataSource before connect', () => {
    const adapter = new DynamoAdapter({ client: fakeClient() });
    expect(() => adapter.createDataSource('Widget')).toThrow(/not connected/);
  });

  it('refuses beginTransaction before connect', async () => {
    const adapter = new DynamoAdapter({ client: fakeClient() });
    await expect(adapter.beginTransaction()).rejects.toThrow(/not connected/);
  });
});

describe('DynamoAdapter — construction validation', () => {
  it('rejects an injected client that is not an object', () => {
    expect(() => new DynamoAdapter({ client: null as unknown as IDynamoClient })).toThrow(
      /must be an object/,
    );
  });

  it('rejects a client lacking the driven surface, naming every missing operation', () => {
    const partial = { scan: () => Promise.resolve({}) } as unknown as IDynamoClient;
    expect(() => new DynamoAdapter({ client: partial })).toThrow(
      /missing the required DynamoDB operations: query, getItem, putItem, updateItem, deleteItem, transactWriteItems, destroy/,
    );
  });

  it('rejects an options bag supplying neither region nor client', () => {
    // `DynamoAdapterOptions` is a union whose arms each require one of the
    // two, so a typed caller cannot reach this — the cast stands in for the
    // plugin's untyped `buildAdapterOptions` carry, which is the only real
    // path here.
    expect(() => new DynamoAdapter({} as unknown as DynamoAdapterOptions)).toThrow(
      /requires either/,
    );
  });

  it('rejects an options bag supplying neither arm at compile time', () => {
    // @ts-expect-error — neither arm of the union is satisfied. The directive
    // is self-validating: if the union ever stops enforcing this, the unused
    // expect-error becomes a compile error of its own.
    const unusable: DynamoAdapterOptions = { entities: {} };
    expect(unusable.entities).toEqual({});
  });
});

describe('DynamoAdapter — lazy client through the real SDK import', () => {
  it('resolves the real SDK client with endpoint and credentials supplied', async () => {
    const adapter = new DynamoAdapter({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'setu-m80', secretAccessKey: 'setu-m80' },
    });
    expect(adapter.isReady()).toBe(false);
    // The AWS SDK constructs a client without touching the network, so
    // connect() resolves against no emulator; the first command is the first
    // thing that can fail on the wire.
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
  });

  it('connects with only a region — endpoint and credentials stay omitted', async () => {
    const adapter = new DynamoAdapter({ region: 'us-east-1' });
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    await adapter.disconnect();
    // A destroyed client is released, so a later connect() re-resolves the
    // module-cached SDK instead of being wedged shut.
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
  });
});

describe('DynamoAdapter — rawQuery refuses by name', () => {
  it('rejects (never throws synchronously) with UnsupportedRawQueryError', async () => {
    const adapter = new DynamoAdapter({ client: fakeClient() });
    await adapter.connect();
    // The method is Promise-typed, so it must reject, not throw synchronously.
    // The CALL must sit inside the assertion: `expect(() => promise)` only ever
    // returns an already-created value and can never throw, so it passed
    // whatever the adapter did.
    let first: Promise<unknown> | undefined;
    expect(() => {
      first = adapter.rawQuery('select 1');
    }).not.toThrow();
    await expect(first).rejects.toBeInstanceOf(UnsupportedRawQueryError);
    await expect(first).rejects.toThrow(/does not support raw SQL/);
  });
});
