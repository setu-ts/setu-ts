/** Real backend setup for the tier-C suites; every object belongs to one run. @module */
import type {
  IDatabaseAdapter,
  IIdempotencyService,
  IPlugin,
  ITransactionalIdempotencyStore,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import {
  createDatabaseIdempotencyStore,
  createDrizzleDatabase,
  DatabasePlugin,
  DrizzleAdapter,
  DynamoAdapter,
  MongoAdapter,
} from '@setu-ts/database-plugin';
import type { IDatabaseService, IUnitOfWork } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { IdempotencyPlugin } from '../../src/index.ts';

export interface BackendHarness {
  readonly adapter: () => IDatabaseAdapter;
  readonly dispose: () => Promise<void>;
}

export async function postgresHarness(url: string) {
  const { Pool } = await import('npm:pg@^8.0.0');
  const { drizzle } = await import('npm:drizzle-orm@0.45.2/node-postgres');
  const { pgTable, text, bigint } = await import('npm:drizzle-orm@0.45.2/pg-core');
  const schema = `m109b_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new Pool({ connectionString: url, max: 6, options: `-c search_path=${schema}` });
  await pool.query(
    await Deno.readTextFile(
      new URL('../../../database-plugin/test/fixtures/idempotency-postgres.sql', import.meta.url),
    ),
  );
  await pool.query('CREATE TABLE business (id text PRIMARY KEY, name text NOT NULL)');
  const claims = pgTable('setu_idempotency', {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    role: text('role').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    result: text('result'),
  });
  const business = pgTable('business', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
  });
  return {
    pool,
    adapter: () =>
      new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
        drizzleTables: { Idempotency: claims, Business: business },
      }),
    dispose: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}

export async function mongoHarness(uri: string): Promise<BackendHarness> {
  const { MongoClient } = await import('npm:mongodb@^6.21.0');
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const database = `m109b_${suffix}`;
  const claims = `claims_${suffix}`;
  const business = `business_${suffix}`;
  const admin = new MongoClient(uri);
  await admin.connect();
  await admin.db(database).createCollection(claims);
  await admin.db(database).createCollection(business);
  return {
    adapter: () =>
      new MongoAdapter({
        url: uri,
        database,
        collections: {
          Idempotency: { collection: claims, idType: 'raw' },
          Business: { collection: business, idType: 'raw' },
        },
      }),
    dispose: async () => {
      await admin.db(database).dropDatabase();
      await admin.close();
    },
  };
}

export async function dynamoHarness(endpoint: string): Promise<BackendHarness> {
  const { DynamoDBClient, CreateTableCommand, DeleteTableCommand } = await import(
    'npm:@aws-sdk/client-dynamodb@^3'
  );
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const options = {
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'setum109bfake', secretAccessKey: 'setum109bsecret' },
  };
  const admin = new DynamoDBClient(options);
  const names = [`m109b_claims_${suffix}`, `m109b_business_${suffix}`];
  for (const TableName of names) {
    await admin.send(
      new CreateTableCommand({
        TableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      }),
    );
  }
  return {
    adapter: () =>
      new DynamoAdapter({
        ...options,
        entities: {
          Idempotency: { table: names[0], partitionKey: 'id' },
          Business: { table: names[1], partitionKey: 'id' },
        },
      }),
    dispose: async () => {
      for (const TableName of names) await admin.send(new DeleteTableCommand({ TableName }));
      admin.destroy();
    },
  };
}

export function withinApp(
  adapter: IDatabaseAdapter,
  plugins: readonly IPlugin[] = [],
  maxResultBytes = 65_536,
  store: RegistryFactory<ITransactionalIdempotencyStore> = createDatabaseIdempotencyStore(),
) {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      ...plugins,
      DatabasePlugin({ type: 'custom', adapter }),
      IdempotencyPlugin({
        transactional: {
          store,
          purge: { schedule: false },
          maxResultBytes,
        },
      }),
    ],
  });
}

export function servicesOf(app: ReturnType<typeof withinApp>) {
  return {
    idempotency: app.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY),
    database: app.services.get<IDatabaseService>(CAPABILITIES.DATABASE),
    store: createDatabaseIdempotencyStore()(app.services),
  };
}

export function withinOptions(key: string, scope = 'tenant:user', namespace = 'orders.create') {
  return { key, scope, namespace, fingerprint: { input: 'order' } };
}

export async function writeBusiness(uow: IUnitOfWork, id: string): Promise<string> {
  await uow.getRepository('Business').create({ id, name: id });
  return id;
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);
  return { promise, resolve };
}
