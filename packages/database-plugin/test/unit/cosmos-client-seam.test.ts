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
  type CosmosSdkModule,
  createInjectedClientLoader,
} from '../../src/adapters/cosmos/cosmos-client.ts';
import type { ICosmosClient } from '../../src/adapters/cosmos/cosmos-client-types.ts';
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

describe('createLazyClientLoader — the plaintext endpoint guard', () => {
  const endpoints: readonly { readonly endpoint: string; readonly refused: boolean }[] = [
    { endpoint: 'http://cosmos.example.com:8081/', refused: true },
    { endpoint: 'http://localhost:8081/', refused: false },
    { endpoint: 'http://127.0.0.1:8081/', refused: false },
    { endpoint: 'http://[::1]:8081/', refused: false },
    { endpoint: 'http://emulator.localhost:8081/', refused: false },
    { endpoint: 'https://cosmos.example.com:443/', refused: false },
  ];
  for (const row of endpoints) {
    it(`${row.refused ? 'refuses' : 'accepts'} ${row.endpoint}`, async () => {
      await withRecordingCosmosSdk(async (record) => {
        const { createLazyClientLoader } =
          await import('../../src/adapters/cosmos/cosmos-client.ts');
        const attempt = createLazyClientLoader(row.endpoint, 'k');
        if (row.refused) {
          await expect(attempt).rejects.toThrow(
            /refuses a plaintext HTTP endpoint on remote host 'cosmos.example.com'/,
          );
          expect(record.configurations).toEqual([]);
        } else {
          await (await attempt).createClient();
          expect(record.configurations).toEqual([{ endpoint: row.endpoint, key: 'k' }]);
        }
      });
    });
  }
});
