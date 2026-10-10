import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from 'npm:@aws-sdk/client-dynamodb@^3';
import { CAPABILITIES } from '@setu-ts/common';
import {
  createDatabaseOutboxStore,
  DatabaseService,
  DynamoAdapter,
  MongoAdapter,
} from '@setu-ts/database-plugin';
import { MockServiceRegistry } from '@setu-ts/testing';
import { postgresOutboxSchema } from '../../../database-plugin/test/fixtures/outbox-postgres.ts';
import { FaultStore } from '../fixtures/outbox.ts';
import { describeOutboxRelayProofs } from '../fixtures/outbox-relay-proofs.ts';
import type { RelayProofBackend } from '../fixtures/outbox-relay-proofs.ts';

const postgres = Deno.env.get('OUTBOX_POSTGRES_URL');
const mongo = Deno.env.get('MONGODB_RS_URI');
const dynamo = Deno.env.get('DYNAMODB_ENDPOINT');

function storeOver(db: DatabaseService): FaultStore {
  const registry = new MockServiceRegistry();
  registry.register(CAPABILITIES.DATABASE, db);
  return new FaultStore(createDatabaseOutboxStore()(registry));
}

describeOutboxRelayProofs('PostgreSQL', async (): Promise<RelayProofBackend> => {
  const schema = await postgresOutboxSchema(postgres!, true);
  await schema.adapter.connect();
  const db = new DatabaseService(
    schema.adapter,
    (entity) => schema.adapter.createDataSource(entity),
    'drizzle',
  );
  return {
    db,
    store: storeOver(db),
    dispose: async () => {
      await db.close();
      await schema.dispose();
    },
  };
}, postgres === undefined);

describeOutboxRelayProofs('MongoDB replica set', async (): Promise<RelayProofBackend> => {
  const collection = `m107b_${crypto.randomUUID().replaceAll('-', '')}`;
  const adapter = new MongoAdapter({
    url: mongo!,
    database: 'setu_m107b',
    collections: {
      Outbox: { collection, idType: 'raw' },
    },
  });
  await adapter.connect();
  const db = new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), 'mongodb');
  return {
    db,
    store: storeOver(db),
    dispose: async () => {
      const rows = await db.getRepository<{ id: string }>('Outbox').findAll();
      for (const row of rows) await db.getRepository('Outbox').delete(row.id);
      await db.close();
    },
  };
}, mongo === undefined);

describeOutboxRelayProofs('DynamoDB Local', async (): Promise<RelayProofBackend> => {
  const table = `m107b_${crypto.randomUUID().replaceAll('-', '')}`;
  const config = {
    endpoint: dynamo!,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  };
  const admin = new DynamoDBClient(config);
  await admin.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }, {
        AttributeName: 'status',
        AttributeType: 'S',
      }, { AttributeName: 'position', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{
        IndexName: 'by-status-position',
        KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, {
          AttributeName: 'position',
          KeyType: 'RANGE',
        }],
        Projection: { ProjectionType: 'ALL' },
      }],
    }),
  );
  await waitUntilTableExists({ client: admin, maxWaitTime: 30 }, { TableName: table });
  const adapter = new DynamoAdapter({
    ...config,
    entities: {
      Outbox: {
        table,
        partitionKey: 'id',
        indexes: { 'by-status-position': { partitionKey: 'status', sortKey: 'position' } },
      },
    },
  });
  await adapter.connect();
  const db = new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), 'dynamodb');
  return {
    db,
    store: storeOver(db),
    dispose: async () => {
      await db.close();
      await admin.send(new DeleteTableCommand({ TableName: table }));
      admin.destroy();
    },
  };
}, dynamo === undefined);
