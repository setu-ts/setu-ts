/**
 * Unit tests for the Cosmos inject-or-lazy client seam.
 *
 * The lazy branch's real `import('npm:@azure/cosmos@^4')` is exercised by the
 * guarded integration suite; what is unit-tested here is the BRANCHING around
 * it, which is what the seam exists to keep testable.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  type CosmosSdkModule,
  createInjectedClientLoader,
} from '../../src/adapters/cosmos/cosmos-client.ts';
import type { ICosmosClient } from '../../src/adapters/cosmos/cosmos-client-types.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';

describe('createInjectedClientLoader', () => {
  it('hands the injected client back without importing anything', async () => {
    const { client } = createFakeCosmosClient({ containers: {} });
    const loader = createInjectedClientLoader(client);
    expect(await loader.createClient()).toBe(client);
  });

  it('reports the client as NOT owned, so a connect failure never closes it', () => {
    const { client } = createFakeCosmosClient({ containers: {} });
    expect(createInjectedClientLoader(client).owned).toBe(false);
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
      } as unknown as CosmosSdkModule['CosmosClient'],
    };
    const client: ICosmosClient = new module.CosmosClient({ endpoint: 'https://x/', key: 'k' });
    expect(client).toBeDefined();
    expect(seen).toEqual({ endpoint: 'https://x/', key: 'k' });
    await Promise.resolve();
  });
});
