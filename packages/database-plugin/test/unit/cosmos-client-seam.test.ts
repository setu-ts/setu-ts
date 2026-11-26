/**
 * Unit tests for the Cosmos inject-or-lazy client seam.
 *
 * The lazy branch's real `import('npm:@azure/cosmos@^4')` is exercised by the
 * guarded integration suite; what is unit-tested here is the BRANCHING around
 * it, which is what the seam exists to keep testable.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import {
  boundCosmosDatabase,
  type CosmosSdkModule,
  createInjectedClientLoader,
} from '../../src/adapters/cosmos/cosmos-client.ts';
import type {
  ICosmosClient,
  ICosmosDatabase,
} from '../../src/adapters/cosmos/cosmos-client-types.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';
import { CosmosAdapter } from '../../src/adapters/cosmos/cosmos-adapter.ts';

describe('createInjectedClientLoader', () => {
  it('hands the injected client back without importing anything', async () => {
    const { client } = createFakeCosmosClient({ containers: {} });
    const loader = createInjectedClientLoader(client);
    expect(await loader.createClient()).toBe(client);
  });

  it('hands back the SAME instance on every call, so nothing is reconstructed', () => {
    const { client } = createFakeCosmosClient({ containers: {} });
    const loader = createInjectedClientLoader(client);
    return Promise.all([loader.createClient(), loader.createClient()]).then(([a, b]) => {
      expect(a).toBe(b);
      expect(a).toBe(client);
    });
  });
});

describe('the SDK module shape the lazy loader adapts', () => {
  it('constructs a client from an endpoint and key', async () => {
    // The lazy loader's only work beyond the import is this construction, so a
    // module honouring the declared shape proves the adaptation without a
    // network or an installed SDK.
    let seen: { endpoint: string; key: string } | undefined;
    const module: CosmosSdkModule = {
      CosmosClient: class {
        constructor(options: { endpoint: string; key: string }) {
          seen = options;
        }
        database(): never {
          throw new Error('unused');
        }
      },
    };
    const client: ICosmosClient = new module.CosmosClient({ endpoint: 'https://x/', key: 'k' });
    expect(client).toBeDefined();
    expect(seen).toEqual({ endpoint: 'https://x/', key: 'k' });
    await Promise.resolve();
  });
});

describe('createLazyClientLoader — the guarded import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the SDK is absent', async () => {
    const { createLazyClientLoader } = await import('../../src/adapters/cosmos/cosmos-client.ts');
    vi.doMock('@azure/cosmos', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await createLazyClientLoader('https://acct.documents.azure.com:443', 'key');
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@azure/cosmos');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@azure/cosmos');
    }
  });
});

/** What a recording `@azure/cosmos` module saw. */
interface CosmosSdkRecord {
  readonly configurations: Record<string, unknown>[];
  readonly databaseReads: (Record<string, unknown> | undefined)[];
}

/** Runs `body` with the lazy arm's `@azure/cosmos` import served by a recording module. */
async function withRecordingCosmosSdk(
  body: (record: CosmosSdkRecord) => Promise<void>,
): Promise<void> {
  const record: CosmosSdkRecord = { configurations: [], databaseReads: [] };
  vi.doMock('@azure/cosmos', () => ({
    CosmosClient: class {
      constructor(options: Record<string, unknown>) {
        record.configurations.push(options);
      }
      database(): unknown {
        return {
          read: (options?: Record<string, unknown>) => {
            record.databaseReads.push(options);
            return Promise.resolve({ statusCode: 200 });
          },
          container: (): never => {
            throw new Error('unused');
          },
        };
      }
    },
  }));
  try {
    await body(record);
  } finally {
    vi.doUnmock('@azure/cosmos');
  }
}

describe('Cosmos clientOptions on the lazy arm', () => {
  it('spreads every clientOptions key into the SDK constructor, endpoint and key winning', async () => {
    await withRecordingCosmosSdk(async (record) => {
      const connectionPolicy = { requestTimeout: 5000 };
      const adapter = new CosmosAdapter({
        endpoint: 'https://top.documents.azure.com:443/',
        key: 'top-key',
        database: 'app',
        clientOptions: {
          endpoint: 'https://inner.documents.azure.com:443/',
          key: 'inner-key',
          connectionPolicy,
          userAgentSuffix: 'setu',
        },
      });
      await adapter.connect();
      await adapter.disconnect();
      expect(record.configurations).toHaveLength(1);
      const configuration = record.configurations[0]!;
      expect(configuration).toEqual({
        endpoint: 'https://top.documents.azure.com:443/',
        key: 'top-key',
        connectionPolicy,
        userAgentSuffix: 'setu',
      });
      expect(Object.keys(configuration).sort()).toEqual([
        'connectionPolicy',
        'endpoint',
        'key',
        'userAgentSuffix',
      ]);
      expect(Object.values(configuration)).not.toContain(undefined);
    });
  });

  it('constructs from endpoint and key alone when clientOptions is absent', async () => {
    await withRecordingCosmosSdk(async (record) => {
      const adapter = new CosmosAdapter({
        endpoint: 'https://acct.documents.azure.com:443/',
        key: 'k',
        database: 'app',
      });
      await adapter.connect();
      await adapter.disconnect();
      expect(record.configurations).toEqual([
        { endpoint: 'https://acct.documents.azure.com:443/', key: 'k' },
      ]);
      expect(Object.keys(record.configurations[0]!).sort()).toEqual(['endpoint', 'key']);
    });
  });

  it('passes an abort signal on the lazy client, and none when the bound is 0', async () => {
    await withRecordingCosmosSdk(async (record) => {
      const bounded = new CosmosAdapter({
        endpoint: 'https://acct.documents.azure.com:443/',
        key: 'k',
        database: 'app',
      });
      await bounded.connect();
      await bounded.disconnect();
      expect(record.databaseReads).toHaveLength(1);
      expect(record.databaseReads[0]?.['abortSignal']).toBeInstanceOf(AbortSignal);

      const unbounded = new CosmosAdapter({
        endpoint: 'https://acct.documents.azure.com:443/',
        key: 'k',
        database: 'app',
        requestTimeoutMs: 0,
      });
      await unbounded.connect();
      await unbounded.disconnect();
      expect(record.databaseReads).toHaveLength(2);
      expect(record.databaseReads[1]?.['abortSignal']).toBeUndefined();
    });
  });

  it('leaves clientOptions unread when a client is injected', async () => {
    await withRecordingCosmosSdk(async (record) => {
      const touched: string[] = [];
      const clientOptions = new Proxy<Record<string, unknown>>(
        { userAgentSuffix: 'setu' },
        {
          get: (target, property) => {
            touched.push(`get:${String(property)}`);
            return Reflect.get(target, property);
          },
          ownKeys: (target) => {
            touched.push('ownKeys');
            return Reflect.ownKeys(target);
          },
        },
      );
      const { client } = createFakeCosmosClient({ containers: {} });
      const adapter = new CosmosAdapter({ client, database: 'app', clientOptions });
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
      await adapter.disconnect();
      expect(record.configurations).toEqual([]);
      expect(touched).toEqual([]);
    });
  });
});

describe('createLazyClientLoader — endpoints passed through unrefused', () => {
  // The SDK itself decides what an http:// endpoint may carry (it refuses only
  // an AAD bearer token over plain HTTP); the loader refuses no scheme or host.
  // `http://cosmos:8081/` is the vNext emulator reached by its Compose service
  // name, which is neither loopback nor HTTPS.
  const endpoints: readonly string[] = [
    'http://cosmos:8081/',
    'http://cosmos.example.com:8081/',
    'http://localhost:8081/',
    'http://127.0.0.1:8081/',
    'http://[::1]:8081/',
    'https://cosmos.example.com:443/',
  ];
  for (const endpoint of endpoints) {
    it(`constructs the client for ${endpoint}`, async () => {
      await withRecordingCosmosSdk(async (record) => {
        const { createLazyClientLoader } =
          await import('../../src/adapters/cosmos/cosmos-client.ts');
        await (await createLazyClientLoader(endpoint, 'k')).createClient();
        expect(record.configurations).toEqual([{ endpoint, key: 'k' }]);
      });
    });
  }
});

describe('boundCosmosDatabase — every facade call carries the bound signal', () => {
  /** Records each call's name and options, and answers with the call's name. */
  function recordingDatabase(): {
    readonly database: ICosmosDatabase;
    readonly calls: { readonly call: string; readonly options: Record<string, unknown> }[];
  } {
    const calls: { readonly call: string; readonly options: Record<string, unknown> }[] = [];
    const answer = (call: string) => (options: Record<string, unknown>) => {
      calls.push({ call, options });
      return Promise.resolve(call);
    };
    const container = {
      read: answer('container.read'),
      item: () => ({
        read: answer('item.read'),
        replace: (_body: unknown, options: Record<string, unknown>) =>
          answer('item.replace')(options),
        patch: (_ops: unknown, options: Record<string, unknown>) => answer('item.patch')(options),
        delete: answer('item.delete'),
      }),
      items: {
        create: (_body: unknown, options: Record<string, unknown>) =>
          answer('items.create')(options),
        batch: (_ops: unknown, _key: unknown, options: Record<string, unknown>) =>
          answer('items.batch')(options),
        query: (_spec: unknown, options: Record<string, unknown>) => ({
          fetchAll: () => answer('items.query')(options),
        }),
      },
    };
    const database = { read: answer('database.read'), container: () => container };
    return { database: database as unknown as ICosmosDatabase, calls };
  }

  it('passes the caller options and an abort signal to each of the nine calls', async () => {
    const { database, calls } = recordingDatabase();
    const bound = boundCosmosDatabase(database, 1_000);
    const container = bound.container('c');
    const item = container.item('id', 'pk');
    const marker = { marker: true } as never;
    const results = await Promise.all([
      bound.read(marker),
      container.read(marker),
      item.read(marker),
      item.replace({ id: 'id' }, marker),
      item.patch([], marker),
      item.delete(marker),
      container.items.create({ id: 'id' }, marker),
      container.items.batch([], 'pk', marker),
      container.items.query({ query: 'SELECT * FROM c', parameters: [] }, marker).fetchAll(),
    ]);
    const names = [
      'database.read',
      'container.read',
      'item.read',
      'item.replace',
      'item.patch',
      'item.delete',
      'items.create',
      'items.batch',
      'items.query',
    ];
    expect(results).toEqual(names);
    expect(calls.map((entry) => entry.call)).toEqual(names);
    for (const entry of calls) {
      expect(entry.options['marker']).toBe(true);
      expect(entry.options['abortSignal']).toBeInstanceOf(AbortSignal);
    }
  });

  it('passes no signal when the bound is off', async () => {
    const { database, calls } = recordingDatabase();
    await boundCosmosDatabase(database, 0).container('c').items.batch([], 'pk');
    expect(calls).toEqual([{ call: 'items.batch', options: {} }]);
  });
});
