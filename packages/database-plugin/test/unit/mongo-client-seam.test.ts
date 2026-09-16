/**
 * Coverage for the inject-or-lazy client seam (`mongo-client.ts`).
 *
 * The injected arms construct nothing, so the branching is covered without any
 * import. The lazy arm at the bottom DOES perform the real
 * `import('npm:mongodb@^6.21.0')` — and reads the constructed client through
 * the `IMongoClient` facade with NO cast, so a facade drift from the real
 * driver surfaces here as a type error too (X47-1). The compile-time half of
 * that guard is `test/types/mongo-seam.assert.ts`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createInjectedClientLoader,
  createLazyClientLoader,
} from '../../src/adapters/mongo/mongo-client.ts';
import { FakeMongoClient, fakeObjectIdCtor } from '../fixtures/fake-mongo-client.ts';

describe('createInjectedClientLoader — no import is performed', () => {
  it('hands back the injected client without constructing anything', async () => {
    const client = new FakeMongoClient();
    const loader = createInjectedClientLoader(client);
    const built = await loader.createClient('mongodb://localhost:27017/db');
    expect(built).toBe(client);
  });

  it('carries an injected ObjectId constructor through the loader', () => {
    const loader = createInjectedClientLoader(new FakeMongoClient(), fakeObjectIdCtor);
    expect(loader.objectIdCtor).toBe(fakeObjectIdCtor);
  });

  it('builds the injected client through the objectIdCtor branch of the loader', async () => {
    const client = new FakeMongoClient();
    const loader = createInjectedClientLoader(client, fakeObjectIdCtor);
    // Invoking createClient exercises the branch that also carries objectIdCtor,
    // so the loader built with an ObjectId constructor is fully covered.
    const built = await loader.createClient('mongodb://localhost:27017/db');
    expect(built).toBe(client);
    expect(loader.objectIdCtor).toBe(fakeObjectIdCtor);
  });

  it('omits the ObjectId constructor when none was supplied', () => {
    const loader = createInjectedClientLoader(new FakeMongoClient());
    expect(loader.objectIdCtor).toBeUndefined();
  });
});

describe('createLazyClientLoader — the real npm:mongodb import', () => {
  it('loads the driver and constructs a client from the url', async () => {
    const loader = await createLazyClientLoader('mongodb://127.0.0.1:27017/testdb');
    const client = await loader.createClient('mongodb://127.0.0.1:27017/testdb');
    expect(client).toBeInstanceOf(Object);
    expect(typeof client.connect).toBe('function');
    expect(loader.objectIdCtor).toBeDefined();
  });
});
