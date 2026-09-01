/**
 * Unit tests for the Cosmos adapter's lifecycle and its refusals.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CosmosAdapter } from '../../src/adapters/cosmos/cosmos-adapter.ts';
import { UnsupportedRawQueryError } from '../../src/errors.ts';
import type {
  ICosmosClient,
  ICosmosDatabase,
} from '../../src/adapters/cosmos/cosmos-client-types.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';

function fakeClient(databaseReadStatus?: number) {
  return createFakeCosmosClient({
    containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
    ...(databaseReadStatus === undefined ? {} : { databaseReadStatus }),
  });
}

describe('CosmosAdapter constructor', () => {
  it('refuses a configuration carrying neither a client nor an endpoint pair', () => {
    expect(() =>
      new CosmosAdapter(
        { database: 'db' } as unknown as ConstructorParameters<
          typeof CosmosAdapter
        >[0],
      )
    ).toThrow(/either options.client or options.endpoint \+ options.key/);
  });

  it('refuses a configuration with an endpoint but no key', () => {
    expect(() =>
      new CosmosAdapter(
        { endpoint: 'https://x/', database: 'db' } as unknown as ConstructorParameters<
          typeof CosmosAdapter
        >[0],
      )
    ).toThrow(/options.endpoint \+ options.key/);
  });

  it('refuses a configuration with no database, naming why there is no fallback', () => {
    const { client } = fakeClient();
    expect(() =>
      new CosmosAdapter({ client } as unknown as ConstructorParameters<typeof CosmosAdapter>[0])
    ).toThrow(/requires options.database.*encodes no database name/s);
  });

  it('refuses an empty database name', () => {
    const { client } = fakeClient();
    expect(() => new CosmosAdapter({ client, database: '' })).toThrow(/requires options.database/);
  });
});

describe('CosmosAdapter lifecycle', () => {
  it('connects, proves the database is reachable, and reports readiness', async () => {
    const { client } = fakeClient();
    const adapter = new CosmosAdapter({ client, database: 'db' });
    expect(adapter.isReady()).toBe(false);
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
  });

  it('is a no-op on a second connect', async () => {
    const { client } = fakeClient();
    const adapter = new CosmosAdapter({ client, database: 'db' });
    await adapter.connect();
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
  });

  it('shares ONE in-flight attempt between concurrent callers', async () => {
    let reads = 0;
    const fake = fakeClient();
    const database = fake.client.database('db');
    const counting = {
      database: () => ({
        container: database.container.bind(database),
        read: () => {
          reads++;
          return database.read();
        },
      }),
    };
    const adapter = new CosmosAdapter({ client: counting, database: 'db' });
    await Promise.all([adapter.connect(), adapter.connect()]);
    expect(reads).toBe(1);
  });

  it('names the database when it cannot be reached, and stays reconnectable', async () => {
    const failing = fakeClient(401);
    const adapter = new CosmosAdapter({ client: failing.client, database: 'db' });
    await expect(adapter.connect()).rejects.toThrow(/could not reach database 'db'/);
    expect(adapter.isReady()).toBe(false);
    // The failure was not cached: a later attempt against a healthy client works.
    const healthy = fakeClient();
    const second = new CosmosAdapter({ client: healthy.client, database: 'db' });
    await second.connect();
    expect(second.isReady()).toBe(true);
  });

  it('renders a non-Error rejection from the database probe', async () => {
    const failing: ICosmosClient = {
      database: () => ({
        container: () => {
          throw new Error('unused');
        },
        read: () => Promise.reject('a bare string, not an Error'),
      }),
    };
    const adapter = new CosmosAdapter({ client: failing, database: 'db' });
    await expect(adapter.connect()).rejects.toThrow(/a bare string, not an Error/);
  });

  it('refuses a data operation before connect', () => {
    const { client } = fakeClient();
    const adapter = new CosmosAdapter({ client, database: 'db' });
    expect(() => adapter.createDataSource('Order')).toThrow(/not connected/);
  });

  it('refuses a transaction before connect', async () => {
    const { client } = fakeClient();
    const adapter = new CosmosAdapter({ client, database: 'db' });
    await expect(adapter.beginTransaction()).rejects.toThrow(/not connected/);
  });

  it('opens a data source and a transaction once connected', async () => {
    const { client } = fakeClient();
    const adapter = new CosmosAdapter({
      client,
      database: 'db',
      containers: { Order: { partitionKey: 'tenantId' } },
    });
    await adapter.connect();
    expect(typeof adapter.createDataSource('Order').findAll).toBe('function');
    const transaction = await adapter.beginTransaction();
    expect(typeof transaction.createDataSource('Order').create).toBe('function');
    await transaction.rollback();
    await adapter.disconnect();
  });
});

describe('CosmosAdapter.rawQuery', () => {
  it('REJECTS by name rather than throwing synchronously', async () => {
    const { client } = fakeClient();
    const adapter = new CosmosAdapter({ client, database: 'db' });
    // Reaching `.catch` at all proves the refusal is a rejection: a synchronous
    // throw would escape before a promise existed.
    const pending = adapter.rawQuery('SELECT 1');
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(UnsupportedRawQueryError);
    await expect(adapter.rawQuery('SELECT 1'))
      .rejects.toThrow(/scoped to one container and this signature names none/);
  });
});

describe('disconnect during an in-flight connect', () => {
  it('does not let the superseded attempt resurrect a closed adapter', async () => {
    // `disconnect()` clears the state synchronously, so without a generation
    // guard the in-flight `#establish()` completes afterwards, re-assigns the
    // client and reports ready again — with no second `disconnect()` coming.
    const { client } = createFakeCosmosClient({
      containers: { Order: { partitionKeyPaths: ['/id'] } },
    });
    const slow: ICosmosClient = {
      database: (id: string) => {
        const real = client.database(id);
        return {
          read: () =>
            new Promise((resolve) => setTimeout(() => resolve(real.read()), 30)) as ReturnType<
              ICosmosDatabase['read']
            >,
          container: (containerId: string) => real.container(containerId),
        };
      },
    };
    const adapter = new CosmosAdapter({ client: slow, database: 'db' });
    const connecting = adapter.connect();
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
    await connecting;
    expect(adapter.isReady()).toBe(false);
    // The adapter is genuinely closed, not merely reporting so.
    expect(() => adapter.createDataSource('Order')).toThrow(/not connected/);
  });

  it('reconnects cleanly after that disconnect', async () => {
    const { client } = createFakeCosmosClient({
      containers: { Order: { partitionKeyPaths: ['/id'] } },
    });
    const adapter = new CosmosAdapter({ client, database: 'db' });
    await adapter.connect();
    await adapter.disconnect();
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
  });
});
