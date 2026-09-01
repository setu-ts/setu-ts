/**
 * Real DynamoDB Local exercise for the public Dynamo adapter and plugin.
 *
 * The low-level AWS client below creates and removes isolated tables only;
 * every application operation is driven through the package barrel.
 *
 * @module
 */
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from 'npm:@aws-sdk/client-dynamodb@^3';
import {
  CAPABILITIES,
  type IDataSource,
  type ILogger,
  type IPlugin,
  type LogMetadata,
  type NormalizedQuery,
  type PageResult,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  DatabasePlugin,
  decodeCursor,
  DynamoAdapter,
  type DynamoEntityMapping,
  type IDatabaseService,
} from '../../src/index.ts';

const dynamoEndpoint = Deno.env.get('DYNAMODB_ENDPOINT');
const skipReal = dynamoEndpoint === undefined;
const endpoint = dynamoEndpoint ?? '';
// DynamoDB Local's signer rejects hyphens in these otherwise fake access keys.
const credentials = {
  accessKeyId: 'setum80fake',
  secretAccessKey: 'setum80secret',
};
const region = 'us-east-1';
const suffix = crypto.randomUUID().replaceAll('-', '');
const table = (name: string): string => `m80_${name}_${suffix}`;

const tables = {
  crud: table('crud'),
  sparse: table('sparse'),
  collection: table('collection'),
  dates: table('dates'),
  gsi: table('gsi'),
  count: table('count'),
  transaction: table('transaction'),
  logging: table('logging'),
} as const;

let admin: DynamoDBClient | undefined;

function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    where: partial.where ?? {},
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
    ...(partial.cursor === undefined ? {} : { cursor: partial.cursor }),
  };
}

function mapping(
  tableName: string,
  partitionKey: string,
  sortKey?: string,
  extra: Omit<DynamoEntityMapping, 'table' | 'partitionKey' | 'sortKey'> = {},
): DynamoEntityMapping {
  return {
    table: tableName,
    partitionKey,
    ...(sortKey === undefined ? {} : { sortKey }),
    ...extra,
  };
}

function adapterFor(
  entity: string,
  entityMapping: DynamoEntityMapping,
  maxPageFetches?: number,
): DynamoAdapter {
  return new DynamoAdapter({
    endpoint,
    region,
    credentials,
    entities: { [entity]: entityMapping },
    ...(maxPageFetches === undefined ? {} : { maxPageFetches }),
  });
}

async function createTable(
  tableName: string,
  partitionKey: string,
  sortKey?: string,
  gsi?: { readonly name: string; readonly partitionKey: string; readonly sortKey: string },
): Promise<void> {
  const client = admin;
  if (client === undefined) throw new Error('DynamoDB Local admin client was not initialized.');
  const names = new Set([
    partitionKey,
    ...(sortKey === undefined ? [] : [sortKey]),
    ...(gsi === undefined ? [] : [gsi.partitionKey, gsi.sortKey]),
  ]);
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [...names].map((AttributeName) => ({
        AttributeName,
        AttributeType: 'S' as const,
      })),
      KeySchema: [
        { AttributeName: partitionKey, KeyType: 'HASH' as const },
        ...(sortKey === undefined ? [] : [{ AttributeName: sortKey, KeyType: 'RANGE' as const }]),
      ],
      ...(gsi === undefined ? {} : {
        GlobalSecondaryIndexes: [{
          IndexName: gsi.name,
          KeySchema: [
            { AttributeName: gsi.partitionKey, KeyType: 'HASH' as const },
            { AttributeName: gsi.sortKey, KeyType: 'RANGE' as const },
          ],
          Projection: { ProjectionType: 'ALL' as const },
        }],
      }),
    }),
  );
  for (;;) {
    const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
    if (described.Table?.TableStatus === 'ACTIVE') return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function connectedSource(
  entity: string,
  entityMapping: DynamoEntityMapping,
  maxPageFetches?: number,
): Promise<
  {
    readonly adapter: DynamoAdapter;
    readonly source: ReturnType<DynamoAdapter['createDataSource']>;
  }
> {
  const adapter = adapterFor(entity, entityMapping, maxPageFetches);
  await adapter.connect();
  return { adapter, source: adapter.createDataSource(entity) };
}

async function findPage(
  source: IDataSource,
  normalizedQuery: NormalizedQuery,
): Promise<PageResult> {
  if (source.findPage === undefined) {
    throw new Error('DynamoDB data source must implement cursor pagination.');
  }
  return await source.findPage(normalizedQuery);
}

class CapturingLogger implements ILogger {
  readonly level = 'trace' as const;
  readonly entries: { readonly message: string; readonly metadata?: LogMetadata }[] = [];
  fatal(message: string, metadata?: LogMetadata): void {
    this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
  }
  error(message: string, metadata?: LogMetadata): void {
    this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
  }
  warn(message: string, metadata?: LogMetadata): void {
    this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
  }
  info(message: string, metadata?: LogMetadata): void {
    this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
  }
  debug(message: string, metadata?: LogMetadata): void {
    this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
  }
  trace(message: string, metadata?: LogMetadata): void {
    this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
  }
  child(): ILogger {
    return this;
  }
}

function loggerPlugin(logger: ILogger): IPlugin {
  return {
    name: 'dynamo-real-test-logger',
    version: '0.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(context): void {
      context.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

describe('DynamoAdapter against DynamoDB Local (guarded)', () => {
  beforeAll(async () => {
    if (skipReal) return;
    admin = new DynamoDBClient({ endpoint, region, credentials });
    await Promise.all([
      createTable(tables.crud, 'id'),
      createTable(tables.sparse, 'pk', 'sk'),
      createTable(tables.collection, 'customerId', 'itemKey'),
      createTable(tables.dates, 'id'),
      createTable(tables.gsi, 'pk', 'sk', {
        name: 'byCustomer',
        partitionKey: 'customerId',
        sortKey: 'createdAt',
      }),
      createTable(tables.count, 'pk', 'sk'),
      createTable(tables.transaction, 'id'),
      createTable(tables.logging, 'pk', 'sk'),
    ]);
  });

  afterAll(async () => {
    if (admin === undefined) return;
    await Promise.all(
      Object.values(tables).map((TableName) => admin!.send(new DeleteTableCommand({ TableName }))),
    );
    admin.destroy();
    admin = undefined;
  });

  it('creates, reads, updates, and deletes through IDataSource', { ignore: skipReal }, async () => {
    const { adapter, source } = await connectedSource('Crud', mapping(tables.crud, 'id'));
    try {
      await expect(source.create({ id: 'one', name: 'first' })).resolves.toEqual({
        id: 'one',
        name: 'first',
      });
      await expect(source.findById('one')).resolves.toEqual({ id: 'one', name: 'first' });
      await expect(source.update('one', { name: 'second' })).resolves.toEqual({
        id: 'one',
        name: 'second',
      });
      await expect(source.findById('one')).resolves.toEqual({ id: 'one', name: 'second' });
      await expect(source.delete('one')).resolves.toBe(true);
      await expect(source.findById('one')).resolves.toBeNull();
    } finally {
      await adapter.disconnect();
    }
  });

  it(
    'keeps a duplicate original and does not create a missing update',
    { ignore: skipReal },
    async () => {
      const { adapter, source } = await connectedSource('Crud', mapping(tables.crud, 'id'));
      try {
        await source.create({ id: 'duplicate', name: 'original' });
        await expect(source.create({ id: 'duplicate', name: 'replacement' })).rejects.toThrow(
          /already exists/i,
        );
        await expect(source.findById('duplicate')).resolves.toEqual({
          id: 'duplicate',
          name: 'original',
        });
        await expect(source.update('missing', { name: 'ghost' })).rejects.toThrow(
          /does not exist/i,
        );
        await expect(source.findById('missing')).resolves.toBeNull();
      } finally {
        await adapter.disconnect();
      }
    },
  );

  it('walks sparse filtered pages in their exact [1, 0, 1, 0] server-page shape', {
    ignore: skipReal,
  }, async () => {
    const { adapter, source } = await connectedSource(
      'Sparse',
      mapping(tables.sparse, 'pk', 'sk'),
      1,
    );
    try {
      for (let number = 1; number <= 10; number += 1) {
        await source.create({
          pk: 'sparse',
          sk: String(number).padStart(3, '0'),
          visible: number === 1 || number === 8,
        });
      }
      const sizes: number[] = [];
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await findPage(
          source,
          query({
            where: { pk: 'sparse' },
            limit: 3,
            ...(cursor === undefined ? {} : { cursor }),
            filter: { type: 'comparison', field: 'visible', operator: 'eq', value: true },
          }),
        );
        sizes.push(page.rows.length);
        ids.push(...page.rows.map((row) => String(row.sk)));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(sizes).toEqual([1, 0, 1, 0]);
      expect(ids).toEqual(['001', '008']);
    } finally {
      await adapter.disconnect();
    }
  });

  it(
    'keeps a stable complete order across equal GSI sort-key tie values',
    { ignore: skipReal },
    async () => {
      const { adapter, source } = await connectedSource(
        'Gsi',
        mapping(tables.gsi, 'pk', 'sk', {
          indexes: { byCustomer: { partitionKey: 'customerId', sortKey: 'createdAt' } },
        }),
      );
      try {
        for (const number of [1, 2, 3]) {
          await source.create({
            pk: `tie-order-${number}`,
            sk: `tie-line-${number}`,
            customerId: 'tie-customer',
            createdAt: '2024-01-01T00:00:00.000Z',
            tie: 'same',
          });
        }
        const found = await source.findAll(
          query({ where: { customerId: 'tie-customer' }, orderBy: { createdAt: 'asc' } }),
        );
        const repeated = await source.findAll(
          query({ where: { customerId: 'tie-customer' }, orderBy: { createdAt: 'asc' } }),
        );
        expect([...found.map((row) => String(row.pk))].sort()).toEqual([
          'tie-order-1',
          'tie-order-2',
          'tie-order-3',
        ]);
        expect(repeated.map((row) => row.pk)).toEqual(found.map((row) => row.pk));
        expect(found.map((row) => row.tie)).toEqual(['same', 'same', 'same']);
      } finally {
        await adapter.disconnect();
      }
    },
  );

  it(
    'retrieves an item collection using its mapped key columns',
    { ignore: skipReal },
    async () => {
      const { adapter, source } = await connectedSource(
        'Collection',
        mapping(tables.collection, 'customerId', 'itemKey'),
      );
      try {
        await source.create({ customerId: 'customer-1', itemKey: 'PROFILE', kind: 'profile' });
        await source.create({ customerId: 'customer-1', itemKey: 'ORDER#001', kind: 'order' });
        await source.create({ customerId: 'customer-1', itemKey: 'ORDER#002', kind: 'order' });
        const rows = await source.findAll(
          query({ where: { customerId: 'customer-1' }, orderBy: { itemKey: 'asc' } }),
        );
        expect(rows.map((row) => row.itemKey)).toEqual(['ORDER#001', 'ORDER#002', 'PROFILE']);
        await expect(source.findById({ customerId: 'customer-1', itemKey: 'PROFILE' })).resolves
          .toMatchObject({ kind: 'profile' });
      } finally {
        await adapter.disconnect();
      }
    },
  );

  it('filters nested fields and declared dates while rejecting an undeclared date', {
    ignore: skipReal,
  }, async () => {
    const { adapter, source } = await connectedSource(
      'Dates',
      mapping(tables.dates, 'id', undefined, { dateAttributes: { createdAt: 'iso' } }),
    );
    try {
      await source.create({
        id: 'old',
        profile: { address: { city: 'Pune' } },
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      await source.create({
        id: 'new',
        profile: { address: { city: 'Pune' } },
        createdAt: new Date('2024-02-01T00:00:00.000Z'),
      });
      const rows = await source.findAll(query({
        filter: {
          type: 'and',
          filters: [
            {
              type: 'comparison',
              field: ['profile', 'address', 'city'],
              operator: 'eq',
              value: 'Pune',
            },
            {
              type: 'comparison',
              field: 'createdAt',
              operator: 'gte',
              value: new Date('2024-01-15T00:00:00.000Z'),
            },
          ],
        },
      }));
      expect(rows.map((row) => row.id)).toEqual(['new']);
      await expect(source.findAll(query({
        filter: {
          type: 'comparison',
          field: 'undeclaredDate',
          operator: 'gte',
          value: new Date('2024-01-01T00:00:00.000Z'),
        },
      }))).rejects.toThrow(/undeclaredDate/);
    } finally {
      await adapter.disconnect();
    }
  });

  it('carries all four GSI and table key values through a two-page cursor walk', {
    ignore: skipReal,
  }, async () => {
    const gsiMapping = mapping(tables.gsi, 'pk', 'sk', {
      indexes: { byCustomer: { partitionKey: 'customerId', sortKey: 'createdAt' } },
    });
    const { adapter, source } = await connectedSource('Gsi', gsiMapping, 1);
    try {
      for (let number = 1; number <= 4; number += 1) {
        await source.create({
          pk: `order-${number}`,
          sk: `line-${number}`,
          customerId: 'customer-1',
          createdAt: `2024-01-0${number}T00:00:00.000Z`,
        });
      }
      const first = await findPage(
        source,
        query({ where: { customerId: 'customer-1' }, orderBy: { createdAt: 'asc' }, limit: 3 }),
      );
      expect(first.rows).toHaveLength(3);
      expect(first.nextCursor).not.toBeNull();
      const decoded = decodeCursor(first.nextCursor!);
      expect(decoded).not.toBeNull();
      if (decoded === null) throw new Error('Expected a DynamoDB GSI cursor.');
      expect(decoded.keyValues).toHaveLength(4);
      const second = await findPage(
        source,
        query({
          where: { customerId: 'customer-1' },
          orderBy: { createdAt: 'asc' },
          limit: 3,
          cursor: first.nextCursor!,
        }),
      );
      expect(second.rows).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    } finally {
      await adapter.disconnect();
    }
  });

  it('counts through DynamoDB Local pages beyond one megabyte', { ignore: skipReal }, async () => {
    const { adapter, source } = await connectedSource('Count', mapping(tables.count, 'pk', 'sk'));
    try {
      const wide = 'x'.repeat(40_000);
      for (let number = 0; number < 30; number += 1) {
        await source.create({ pk: 'wide', sk: String(number).padStart(3, '0'), wide });
      }
      await expect(source.count({ pk: 'wide' })).resolves.toBe(30);
    } finally {
      await adapter.disconnect();
    }
  });

  it('flushes deferred transaction writes on commit and sends none on rollback', {
    ignore: skipReal,
  }, async () => {
    const entityMapping = mapping(tables.transaction, 'id');
    const adapter = adapterFor('Transaction', entityMapping);
    await adapter.connect();
    try {
      const committed = await adapter.beginTransaction();
      const committedSource = committed.createDataSource('Transaction');
      await committedSource.create({ id: 'commit', value: 1 });
      await committed.commit();
      await expect(adapter.createDataSource('Transaction').findById('commit')).resolves
        .toMatchObject({ value: 1 });
      const rolledBack = await adapter.beginTransaction();
      await rolledBack.createDataSource('Transaction').create({ id: 'rollback', value: 2 });
      await rolledBack.rollback();
      await expect(adapter.createDataSource('Transaction').findById('rollback')).resolves
        .toBeNull();
    } finally {
      await adapter.disconnect();
    }
  });

  it('reports Query and Scan choices through the public logQueries service seam', {
    ignore: skipReal,
  }, async () => {
    const logger = new CapturingLogger();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        loggerPlugin(logger),
        DatabasePlugin({
          type: 'dynamodb',
          options: {
            endpoint,
            region,
            credentials,
            logQueries: true,
            entities: { Logged: mapping(tables.logging, 'pk', 'sk') },
          },
        }),
      ],
    });
    await app.start();
    try {
      const database = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const repository = database.getRepository<
        { pk: string; sk: string; colour: string },
        { pk: string; sk: string }
      >('Logged');
      await repository.create({ pk: 'one', sk: 'a', colour: 'blue' });
      await repository.findAll({ where: { pk: 'one' } });
      await repository.findAll({
        filter: { type: 'comparison', field: 'colour', operator: 'eq', value: 'blue' },
      });
      const paths = logger.entries
        .filter((entry) => entry.message === '[Logged] findAll')
        .map((entry) => entry.metadata?.accessPath);
      expect(paths).toEqual(['Query', 'Scan']);
    } finally {
      await app.stop();
    }
  });
});
