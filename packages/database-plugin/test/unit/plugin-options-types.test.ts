/**
 * D7 — the adapter-specific options a built-in arm cannot run without are
 * required by the union, so omitting one is a compile error rather than a
 * `connect()` throw.
 *
 * These assertions are compile-only: `@ts-expect-error` fails the build when
 * the configuration below starts type-checking again, which is the whole
 * guarantee. The runtime guards behind them are asserted separately, in each
 * adapter's own suite, because a JavaScript caller still reaches them.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, type IPluginContext } from '@setu-ts/common';
import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import { createDrizzleDatabase } from '../../src/index.ts';
import type { IDynamoClient } from '../../src/index.ts';
import type { DynamoAttributeMap } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import type {
  BuiltInDatabaseOptions,
  DatabasePluginOptions,
  IDatabaseService,
} from '../../src/interfaces/index.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';

/**
 * A minimal plugin context recording what the plugin registered.
 *
 * @param registered - The map each registration lands in
 * @returns The context
 */
function createPluginContext(registered: Map<string, unknown>): IPluginContext {
  return {
    services: {
      has: () => false,
      get: () => undefined,
      register: (token: string, service: unknown) => {
        registered.set(token, service);
      },
    },
    health: { register: () => {} },
    lifecycle: { onClose: () => {} },
    runtime: { hrtime: () => 0 },
  } as unknown as IPluginContext;
}

/** Never invoked; every assertion here is made by the type-checker. */
function assertOptionArms(): void {
  // --- accepted -----------------------------------------------------------
  DatabasePlugin();
  DatabasePlugin({});
  DatabasePlugin({ type: 'memory' });
  DatabasePlugin({ type: 'memory', name: 'scratch', options: { logQueries: true } });
  DatabasePlugin({ type: 'prisma', options: { prismaClient: {} } });
  DatabasePlugin({
    type: 'prisma',
    options: { prismaClient: {}, provider: 'postgresql', transactionTimeout: 60_000 },
  });
  DatabasePlugin({
    type: 'drizzle',
    options: {
      drizzleInstance: createDrizzleDatabase(
        createFakeDrizzleInstance(),
        (database, work) => database.transaction(work),
      ),
      drizzleTables: { user: createFakeDrizzleTable('user') },
    },
  });

  // --- refused ------------------------------------------------------------
  // @ts-expect-error the Prisma arm requires `options`.
  DatabasePlugin({ type: 'prisma' });
  // @ts-expect-error the Prisma arm requires `options.prismaClient`.
  DatabasePlugin({ type: 'prisma', options: { logQueries: true } });
  // @ts-expect-error the Drizzle arm requires `options`.
  DatabasePlugin({ type: 'drizzle' });
  DatabasePlugin({
    type: 'drizzle',
    // @ts-expect-error the Drizzle arm requires `options.drizzleInstance`.
    options: { drizzleTables: { user: createFakeDrizzleTable('user') } },
  });
  DatabasePlugin({
    type: 'drizzle',
    // @ts-expect-error the Drizzle arm requires `options.drizzleTables`.
    options: {
      drizzleInstance: createDrizzleDatabase(
        createFakeDrizzleInstance(),
        (database, work) => database.transaction(work),
      ),
    },
  });
  // @ts-expect-error the memory arm does not accept another adapter's discriminant.
  DatabasePlugin({ type: 'sqlite' });

  // `BuiltInDatabaseOptions` keeps its published name and still accepts a
  // memory configuration, so an existing annotation compiles unchanged.
  const memory: BuiltInDatabaseOptions = { name: 'scratch' };
  const plugin: DatabasePluginOptions = memory;
  void plugin;

  // --- the mongodb arm ----------------------------------------------------
  // Either half of the union satisfies it on its own.
  const mongoLazy: DatabasePluginOptions = {
    type: 'mongodb',
    options: { url: 'mongodb://127.0.0.1:27017/app' },
  };
  void mongoLazy;
  const mongoInjected: DatabasePluginOptions = {
    type: 'mongodb',
    options: { client: {} as never, database: 'app' },
  };
  void mongoInjected;

  // `logQueries` is read by the SERVICE for every arm and carried by
  // `buildAdapterOptions`, so the Mongo arm must be able to express it. It was
  // the only built-in arm that could not: the options type did not inherit the
  // shared bag, so this literal failed excess-property checking (TS2353) while
  // the feature worked at runtime.
  const mongoLogged: DatabasePluginOptions = {
    type: 'mongodb',
    options: { url: 'mongodb://127.0.0.1:27017/app', logQueries: true },
  };
  void mongoLogged;

  // --- rejected -----------------------------------------------------------
  const mongoNeither: DatabasePluginOptions = {
    type: 'mongodb',
    // @ts-expect-error -- neither `url` nor `client`: no arm of the union matches.
    options: { database: 'app' },
  };
  void mongoNeither;

  // --- the dynamodb arm ---------------------------------------------------
  // Either half of the union satisfies it on its own.
  const dynamoLazy: DatabasePluginOptions = {
    type: 'dynamodb',
    options: { region: 'us-east-1', endpoint: 'http://127.0.0.1:8000' },
  };
  void dynamoLazy;
  const dynamoInjected: DatabasePluginOptions = {
    type: 'dynamodb',
    options: { client: {} as never, maxPageFetches: 5 },
  };
  void dynamoInjected;

  // `logQueries` rides the shared bag on the Dynamo arm too, so the literal
  // must express it without tripping excess-property checking.
  const dynamoLogged: DatabasePluginOptions = {
    type: 'dynamodb',
    options: { region: 'us-east-1', logQueries: true },
  };
  void dynamoLogged;

  // --- rejected -----------------------------------------------------------
  // @ts-expect-error the DynamoDB arm requires `options`.
  DatabasePlugin({ type: 'dynamodb' });
  DatabasePlugin({
    type: 'dynamodb',
    // @ts-expect-error -- neither `region` nor `client`: no arm of the union matches.
    options: { endpoint: 'http://127.0.0.1:8000' },
  });
  // --- the cosmos arm -----------------------------------------------------
  // Either half of the union satisfies it on its own, and `database` is
  // required on both because a Cosmos endpoint encodes no database name.
  const cosmosLazy: DatabasePluginOptions = {
    type: 'cosmos',
    options: { endpoint: 'https://acct.documents.azure.com:443/', key: 'k', database: 'app' },
  };
  void cosmosLazy;
  const cosmosInjected: DatabasePluginOptions = {
    type: 'cosmos',
    options: {
      client: {} as never,
      database: 'app',
      containers: { Order: { container: 'orders', partitionKey: 'tenantId' } },
      logQueries: true,
    },
  };
  void cosmosInjected;

  const cosmosNoDatabase: DatabasePluginOptions = {
    type: 'cosmos',
    // @ts-expect-error -- `database` is required on both arms.
    options: { endpoint: 'https://acct.documents.azure.com:443/', key: 'k' },
  };
  void cosmosNoDatabase;

  const cosmosNoCredential: DatabasePluginOptions = {
    type: 'cosmos',
    // @ts-expect-error -- neither an endpoint/key pair nor a client: no arm matches.
    options: { database: 'app' },
  };
  void cosmosNoCredential;

  const cosmosKeyOnly: DatabasePluginOptions = {
    type: 'cosmos',
    // @ts-expect-error -- an endpoint without its key matches no arm.
    options: { endpoint: 'https://acct.documents.azure.com:443/', database: 'app' },
  };
  void cosmosKeyOnly;

  // --- the bigtable arm ----------------------------------------------------
  // Either half of the union satisfies it on its own, and `instance` is
  // required on both: a table is addressed as project/instance/table, and
  // neither an injected client nor a project id encodes the instance.
  const bigtableLazy: DatabasePluginOptions = {
    type: 'bigtable',
    options: { projectId: 'p', instance: 'app', apiEndpoint: '127.0.0.1:8086' },
  };
  void bigtableLazy;
  const bigtableInjected: DatabasePluginOptions = {
    type: 'bigtable',
    options: {
      client: {} as never,
      instance: 'app',
      tables: {
        Order: {
          table: 'orders',
          rowKey: { fields: ['tenantId', 'orderId'] },
          columnFamily: 'o',
          valueEncoding: 'raw',
        },
      },
      maxPageFetches: 3,
      logQueries: true,
    },
  };
  void bigtableInjected;

  const bigtableNoInstance: DatabasePluginOptions = {
    type: 'bigtable',
    // @ts-expect-error -- `instance` is required on both arms.
    options: { projectId: 'p' },
  };
  void bigtableNoInstance;

  const bigtableNoClientForm: DatabasePluginOptions = {
    type: 'bigtable',
    // @ts-expect-error -- neither a projectId nor a client: no arm matches.
    options: { instance: 'app' },
  };
  void bigtableNoClientForm;
}
void assertOptionArms;

describe('DatabasePlugin option arms', () => {
  it('registers a fully specified drizzle configuration', () => {
    const plugin = DatabasePlugin({
      type: 'drizzle',
      options: {
        drizzleInstance: createDrizzleDatabase(
          createFakeDrizzleInstance(),
          (database, work) => database.transaction(work),
        ),
        drizzleTables: { user: createFakeDrizzleTable('user') },
      },
    });
    expect(plugin.name).toBe('database-plugin');
  });

  it('still defaults to the memory arm when no type is given', () => {
    expect(DatabasePlugin().name).toBe('database-plugin');
  });

  it("drives the factory's 'dynamodb' case through the options arm to a working adapter", async () => {
    // Mirrors plugin-coverage.test.ts's mongodb adapter-selection test, but
    // lives here because Slice 8's file list extends THIS file with the
    // factory assertion. The injected-client arm performs no SDK import and no
    // I/O on `connect()`, so a write can be read back through the repository —
    // a constructed-but-unwired adapter would fail the read-back.
    const table = new Map<string, DynamoAttributeMap>();
    const client: IDynamoClient = {
      query: () => Promise.resolve({}),
      scan: () => Promise.resolve({}),
      getItem: (input) => {
        const key = input.Key.id?.S;
        const item = key === undefined ? undefined : table.get(key);
        return Promise.resolve(item === undefined ? {} : { Item: item });
      },
      putItem: (input) => {
        const key = input.Item.id?.S;
        if (key !== undefined) table.set(key, input.Item);
        return Promise.resolve({});
      },
      updateItem: () => Promise.resolve({}),
      deleteItem: () => Promise.resolve({}),
      transactWriteItems: () => Promise.resolve({}),
      destroy() {},
    };
    const registered = new Map<string, unknown>();
    const ctx = createPluginContext(registered);

    // Every DynamoDB key `buildAdapterOptions` carries rides this one bag, so
    // the carry-through is exercised in the same drive.
    const plugin = DatabasePlugin({
      type: 'dynamodb',
      options: {
        client,
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:8000',
        credentials: { accessKeyId: 'setu-m80', secretAccessKey: 'setu-m80' },
        maxPageFetches: 3,
      },
    });
    await plugin.register(ctx);

    const db = registered.get(CAPABILITIES.DATABASE) as IDatabaseService;
    const widgets = db.getRepository<{ id: string; name: string }>('Widget');
    await widgets.create({ id: 'w1', name: 'Bolt' });
    expect(await widgets.findById('w1')).toEqual({ id: 'w1', name: 'Bolt' });
  });

  it('registers the bigtable arm and serves a repository through it', async () => {
    const store = new FakeBigtableStore();
    const registered = new Map<string, unknown>();
    const ctx = createPluginContext(registered);
    const plugin = DatabasePlugin({
      type: 'bigtable',
      options: {
        client: createFakeBigtableClient(store),
        instance: 'app',
        tables: { Widget: { table: 'widgets', columnFamily: 'w' } },
        maxPageFetches: 3,
      },
    });
    await plugin.register(ctx);

    const db = registered.get(CAPABILITIES.DATABASE) as IDatabaseService;
    const widgets = db.getRepository<{ id: string; name: string }>('Widget');
    await widgets.create({ id: 'w1', name: 'Bolt' });
    // Read back through the repository AND through the raw store, so the arm
    // is proven to have reached the mapped table rather than a default one.
    expect(await widgets.findById('w1')).toEqual({ id: 'w1', name: 'Bolt' });
    expect(store.snapshot('widgets', 'w1')).toEqual({ w: { id: 's:w1', name: 's:Bolt' } });
  });
});
