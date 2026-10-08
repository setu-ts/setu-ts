/**
 * The outbox store bridge against the REAL non-SQL backends (M107 §3.4, §6),
 * each driven through a real kernel application: `DatabasePlugin` with the
 * backend's adapter, `MessagingPlugin({ outbox })`, and the default in-memory
 * broker.
 *
 * - **MongoDB replica set** (`MONGODB_RS_URI`): a business document and its
 *   outbox row commit in one transaction; the relay delivers the row.
 * - **DynamoDB Local** (`DYNAMODB_ENDPOINT`): WITH the GSI
 *   `{ partitionKey: 'status', sortKey: 'position' }` (projection `ALL`) the
 *   relay pages `position > after` across several pages and delivers every row
 *   in order; WITHOUT it `start()` refuses with the `dynamodb-index` reason.
 * - **Bigtable emulator** (`BIGTABLE_EMULATOR_ENDPOINT`): `start()` refuses
 *   with the `bigtable` reason.
 * - **Cosmos emulator** (`COSMOS_ENDPOINT`, local-only — no CI service): the
 *   outbox shares the business CONTAINER and partition; business documents
 *   carrying `status: 'pending'` and `'sent'` are never read, counted,
 *   transitioned or purged.
 *
 * The standalone-MongoDB refusal is driven by `database-plugin`'s
 * `outbox-store-real.test.ts` (on `MONGODB_URI`) and is not repeated here.
 * Every case guards with `ignore:` on its variable — never an early return.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as dynamoSdk from 'npm:@aws-sdk/client-dynamodb@^3';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from 'npm:@aws-sdk/client-dynamodb@^3';
import type { IDatabaseAdapter, IMessageBroker } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import {
  BigtableAdapter,
  CosmosAdapter,
  createDatabaseOutboxStore,
  DatabasePlugin,
  DynamoAdapter,
  MongoAdapter,
  OutboxStoreUnavailableError,
} from '@setu-ts/database-plugin';
import type { IDatabaseService, IDynamoClient } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { MessagingPlugin } from '../../src/index.ts';
import type { IOutbox, OutboxRelayOptions } from '../../src/index.ts';
import { orderPlaced } from '../fixtures/outbox.ts';

const mongoRsUri = Deno.env.get('MONGODB_RS_URI');
const dynamoEndpoint = Deno.env.get('DYNAMODB_ENDPOINT');
const bigtableEndpoint = Deno.env.get('BIGTABLE_EMULATOR_ENDPOINT');
const cosmosEndpoint = Deno.env.get('COSMOS_ENDPOINT');
/** The well-known emulator key, overridable for a real account. */
const cosmosKey = Deno.env.get('COSMOS_KEY') ??
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);

/** Builds an app over one adapter, relaying only when asked. */
function appOver(adapter: IDatabaseAdapter, relay: OutboxRelayOptions = {}): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      DatabasePlugin({ type: 'custom', adapter }),
      MessagingPlugin({
        outbox: { store: createDatabaseOutboxStore(), relay: { schedule: false, ...relay } },
      }),
    ],
  });
}

/** Subscribes a recorder of `[envelope id, data.n]` pairs to the order topic. */
async function recorder(app: IKernelApplication): Promise<[string, number][]> {
  const seen: [string, number][] = [];
  await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).subscribe(
    orderPlaced.topic,
    (message) => {
      const envelope = message as { id: string; data: { n: number } };
      seen.push([envelope.id, envelope.data.n]);
    },
  );
  return seen;
}

/** Lets the in-memory broker deliver. */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The error `start()` rejected with. */
async function startFailure(app: IKernelApplication): Promise<unknown> {
  return await app.start().then(() => undefined, (error: unknown) => error);
}

describe('outbox over a real MongoDB replica set', { ignore: mongoRsUri === undefined }, () => {
  it('commits a business document and its outbox row in one transaction, and relays it', async () => {
    const adapter = new MongoAdapter({
      url: mongoRsUri!,
      database: 'setu_m107_outbox',
      collections: {
        Outbox: { collection: `outbox_${suffix}`, idType: 'raw' },
        Order: { collection: `orders_${suffix}`, idType: 'raw' },
      },
    });
    const app = appOver(adapter);
    await app.start();
    try {
      const seen = await recorder(app);
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
      const id = await db.transaction(async (uow) => {
        await uow.getRepository('Order').create({ id: 'o-1', total: 3 });
        return await outbox.write(uow, orderPlaced, { key: 'K', n: 1 });
      });
      const failed = await db.transaction(async (uow) => {
        await uow.getRepository('Order').create({ id: 'o-2', total: 4 });
        await outbox.write(uow, orderPlaced, { key: 'K', n: 2 });
        throw new Error('business rule');
      }).catch((error: unknown) => error);

      const result = await outbox.sweep();
      await settle();

      expect((failed as Error).message).toBe('business rule');
      expect(result.published).toBe(1);
      expect(seen).toEqual([[id, 1]]);
      const orders = await db.getRepository<{ id: string }>('Order').findAll();
      expect(orders.map((o) => o.id)).toEqual(['o-1']);
      const row = await db.getRepository<Record<string, unknown>, string>('Outbox').findById(id);
      expect(row?.status).toBe('sent');
    } finally {
      await app.stop();
    }
  });
});

describe('outbox over real DynamoDB Local', { ignore: dynamoEndpoint === undefined }, () => {
  const credentials = { accessKeyId: 'setum107fake', secretAccessKey: 'setum107secret' };
  const region = 'us-east-1';

  /** Creates a table keyed by `id`, optionally with the outbox GSI. */
  async function createTable(name: string, withIndex: boolean): Promise<DynamoDBClient> {
    const admin = new DynamoDBClient({ endpoint: dynamoEndpoint!, region, credentials });
    await admin.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'id', AttributeType: 'S' },
          ...(withIndex
            ? [
              { AttributeName: 'status', AttributeType: 'S' as const },
              { AttributeName: 'position', AttributeType: 'S' as const },
            ]
            : []),
        ],
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        ...(withIndex
          ? {
            GlobalSecondaryIndexes: [{
              IndexName: 'by-status-position',
              KeySchema: [
                { AttributeName: 'status', KeyType: 'HASH' as const },
                { AttributeName: 'position', KeyType: 'RANGE' as const },
              ],
              Projection: { ProjectionType: 'ALL' as const },
            }],
          }
          : {}),
      }),
    );
    for (;;) {
      const described = await admin.send(new DescribeTableCommand({ TableName: name }));
      if (described.Table?.TableStatus === 'ACTIVE') return admin;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Every query and scan the adapter sent, recorded on the way to the real service. */
  interface SentRead {
    readonly command: 'query' | 'scan';
    readonly input: Record<string, unknown>;
  }

  /**
   * The REAL SDK client adapted to the structural facade, recording each
   * query and scan input — so the test can see whether `position > after` ran
   * as a key condition on the GSI rather than as a scan.
   */
  function recordingClient(sent: SentRead[]): IDynamoClient {
    const client = new DynamoDBClient({ endpoint: dynamoEndpoint!, region, credentials });
    const send = (command: unknown): Promise<never> =>
      client.send(command as never) as Promise<never>;
    return {
      query: (input) => {
        sent.push({ command: 'query', input: { ...input } });
        return send(new dynamoSdk.QueryCommand(input as never));
      },
      scan: (input) => {
        sent.push({ command: 'scan', input: { ...input } });
        return send(new dynamoSdk.ScanCommand(input as never));
      },
      getItem: (input) => send(new dynamoSdk.GetItemCommand(input as never)),
      putItem: (input) => send(new dynamoSdk.PutItemCommand(input as never)),
      updateItem: (input) => send(new dynamoSdk.UpdateItemCommand(input as never)),
      deleteItem: (input) => send(new dynamoSdk.DeleteItemCommand(input as never)),
      transactWriteItems: (input) => send(new dynamoSdk.TransactWriteItemsCommand(input as never)),
      destroy: () => client.destroy(),
    };
  }

  /** The adapter over one outbox table, with or without the GSI declared. */
  function dynamo(table: string, withIndex: boolean, client?: IDynamoClient): DynamoAdapter {
    return new DynamoAdapter({
      ...(client === undefined ? { endpoint: dynamoEndpoint!, region, credentials } : { client }),
      entities: {
        Outbox: {
          table,
          partitionKey: 'id',
          ...(withIndex
            ? { indexes: { 'by-status-position': { partitionKey: 'status', sortKey: 'position' } } }
            : {}),
        },
      },
    });
  }

  it('with the status/position GSI, pages position > after across pages and relays every row in order', async () => {
    const table = `m107_outbox_gsi_${suffix}`;
    const admin = await createTable(table, true);
    // pageSize 2 over 7 rows: four pages, each after the previous page's cursor.
    const sent: SentRead[] = [];
    const app = appOver(dynamo(table, true, recordingClient(sent)), { pageSize: 2 });
    try {
      await app.start();
      const seen = await recorder(app);
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
      const ids: string[] = [];
      for (let n = 1; n <= 7; n++) {
        ids.push(await db.transaction((uow) => outbox.write(uow, orderPlaced, { key: 'K', n })));
      }

      sent.length = 0;
      const result = await outbox.sweep();
      await settle();

      // Every pending-set read was a Query on the GSI keyed by status; every
      // page after the first carried `position > after` IN the key condition.
      const pages = sent.filter((read) =>
        read.input.IndexName === 'by-status-position' &&
        JSON.stringify(read.input.ExpressionAttributeValues).includes('"pending"')
      );
      expect(sent.some((read) => read.command === 'scan')).toBe(false);
      expect(pages.length).toBeGreaterThanOrEqual(4);
      expect(pages.every((read) => read.command === 'query')).toBe(true);
      const keyed = pages.filter((read) => String(read.input.KeyConditionExpression).includes('>'));
      expect(keyed.length).toBe(pages.length - 1);
      for (const read of keyed) {
        expect(String(read.input.FilterExpression ?? '')).not.toContain('>');
      }
      expect(result.published).toBe(7);
      expect(result.endedBy).toBe('complete');
      expect(seen).toEqual(ids.map((id, index): [string, number] => [id, index + 1]));
      const stats = await createDatabaseOutboxStore()(app.services).stats();
      expect(stats).toEqual({ pending: 0, failed: 0 });
    } finally {
      await app.stop();
      await admin.send(new DeleteTableCommand({ TableName: table }));
    }
  });

  it('without the GSI, start() refuses with the dynamodb-index reason', async () => {
    const table = `m107_outbox_nogsi_${suffix}`;
    const admin = await createTable(table, false);
    const app = appOver(dynamo(table, false));
    try {
      const failure = await startFailure(app);
      expect(failure).toBeInstanceOf(OutboxStoreUnavailableError);
      expect((failure as OutboxStoreUnavailableError).reason).toBe('dynamodb-index');
    } finally {
      await app.stop().catch(() => {});
      await admin.send(new DeleteTableCommand({ TableName: table }));
    }
  });
});

describe('outbox over the real Bigtable emulator', {
  ignore: bigtableEndpoint === undefined,
}, () => {
  it('start() refuses with the bigtable reason', async () => {
    const app = appOver(
      new BigtableAdapter({
        projectId: 'setu-m107',
        instance: 'setu-m107-instance',
        apiEndpoint: bigtableEndpoint!,
      }),
    );
    const failure = await startFailure(app);
    await app.stop().catch(() => {});
    expect(failure).toBeInstanceOf(OutboxStoreUnavailableError);
    expect((failure as OutboxStoreUnavailableError).reason).toBe('bigtable');
  });
});

describe('outbox in a shared Cosmos container (local emulator only)', {
  ignore: cosmosEndpoint === undefined,
}, () => {
  it('never reads, counts, transitions or purges business documents carrying a status', async () => {
    const { CosmosClient } = await import('npm:@azure/cosmos@^4');
    const client = new CosmosClient({ endpoint: cosmosEndpoint!, key: cosmosKey });
    const { database } = await client.databases.createIfNotExists({ id: 'setu_m107' });
    const container = `orders_${suffix}`;
    await database.containers.createIfNotExists({
      id: container,
      partitionKey: { paths: ['/tenantId'] },
    });
    const app = appOver(
      new CosmosAdapter({
        endpoint: cosmosEndpoint!,
        key: cosmosKey,
        database: 'setu_m107',
        containers: {
          // The outbox maps onto the BUSINESS container and partition.
          Outbox: { container, partitionKey: 'tenantId' },
          Order: { container, partitionKey: 'tenantId' },
        },
      }),
    );
    await app.start();
    try {
      const seen = await recorder(app);
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
      // Business documents in the SAME container carrying the relay's statuses.
      await db.getRepository('Order').create({
        id: 'b-pending',
        tenantId: 't1',
        status: 'pending',
      });
      await db.getRepository('Order').create({ id: 'b-sent', tenantId: 't1', status: 'sent' });
      const id = await db.transaction(async (uow) => {
        await uow.getRepository('Order').create({ id: 'o-1', tenantId: 't1', total: 9 });
        return await outbox.write(uow, orderPlaced, { n: 1 }, { tenantId: 't1' });
      });

      const store = createDatabaseOutboxStore()(app.services);
      expect(await store.stats()).toMatchObject({ pending: 1, failed: 0 });
      const result = await outbox.sweep();
      await settle();
      expect(result.published).toBe(1);
      expect(seen).toEqual([[id, 1]]);
      expect(await store.markSent('b-pending', { settledAt: 1, sentBy: 'x', deleteNow: false }))
        .toEqual({ outcome: 'missing' });
      expect(await store.purge(Number.MAX_SAFE_INTEGER, 100)).toBe(1);

      const orders = db.getRepository<Record<string, unknown>, string>('Order');
      expect((await orders.findById('b-pending'))?.status).toBe('pending');
      expect((await orders.findById('b-sent'))?.status).toBe('sent');
      expect(await orders.findById('o-1')).not.toBeNull();
    } finally {
      await app.stop();
      await database.container(container).delete();
    }
  });
});
