/**
 * How each NoSQL store's commit failure maps to a framework error, and the
 * same-row refusal that runs before any committed read.
 *
 * The mapping is data: each row names the buffered writes, the store's
 * failure, and the error the commit must throw. `nosql-transactional-conditional.test.ts`
 * drives the conditional write paths end to end; this file pins the
 * per-store classification and the read-free refusal.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { DuplicateKeyError } from '@setu-ts/common';
import {
  BigtableAdapter,
  BigtableTransactionScopeError,
  CosmosAdapter,
  CosmosTransactionScopeError,
  DynamoAdapter,
  SerializationConflictError,
  UnsupportedQueryFeatureError,
} from '../../src/index.ts';
import type { IDataSource } from '@setu-ts/common';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { dynamoFixture } from '../fixtures/conditional-dynamo.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';

type ErrorClass = abstract new (...args: never[]) => Error;

/** A DynamoDB client whose commit is refused with the scripted error. */
function dynamoRefusing(refusal: Error): { client: IDynamoClient; reads: () => number } {
  const fixture = dynamoFixture();
  let reads = 0;
  const client: IDynamoClient = {
    ...fixture.client,
    getItem: (input, options) => {
      reads += 1;
      return fixture.client.getItem(input, options);
    },
    transactWriteItems: () => Promise.reject(refusal),
  };
  return { client, reads: () => reads };
}

function cancelled(...codes: string[]): Error {
  return Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

type DynamoWrite = 'create' | 'update' | 'delete';

const dynamoRows: readonly {
  readonly name: string;
  readonly writes: readonly DynamoWrite[];
  readonly refusal: () => Error;
  readonly expected: ErrorClass | 'unchanged';
}[] = [
  {
    name: 'ConditionalCheckFailed on a Put is a duplicate key',
    writes: ['create'],
    refusal: () => cancelled('ConditionalCheckFailed'),
    expected: DuplicateKeyError,
  },
  {
    name: 'ConditionalCheckFailed on an Update is a serialization conflict',
    writes: ['update'],
    refusal: () => cancelled('ConditionalCheckFailed'),
    expected: SerializationConflictError,
  },
  {
    name: 'ConditionalCheckFailed on a Delete is a serialization conflict',
    writes: ['delete'],
    refusal: () => cancelled('ConditionalCheckFailed'),
    expected: SerializationConflictError,
  },
  {
    name: 'the Put decides first when a Put and an Update both failed',
    writes: ['update', 'create'],
    refusal: () => cancelled('ConditionalCheckFailed', 'ConditionalCheckFailed'),
    expected: DuplicateKeyError,
  },
  {
    name: 'TransactionConflict on a Put is a serialization conflict',
    writes: ['create'],
    refusal: () => cancelled('TransactionConflict'),
    expected: SerializationConflictError,
  },
  {
    name: 'TransactionConflict beside a passing Put is a serialization conflict',
    writes: ['create', 'update'],
    refusal: () => cancelled('None', 'TransactionConflict'),
    expected: SerializationConflictError,
  },
  {
    name: 'another cancellation reason is passed through unchanged',
    writes: ['update'],
    refusal: () => cancelled('ValidationError'),
    expected: 'unchanged',
  },
  {
    name: 'a rejection that is not a cancellation is passed through unchanged',
    writes: ['update'],
    refusal: () => Object.assign(new Error('throttled'), { name: 'ThrottlingException' }),
    expected: 'unchanged',
  },
];

async function bufferDynamo(source: IDataSource, write: DynamoWrite, id: string): Promise<void> {
  if (write === 'create') await source.create({ id, version: 1 });
  else if (write === 'update') await source.update(id, { version: 2 });
  else await source.delete(id);
}

describe('DynamoDB commit failure mapping', () => {
  for (const row of dynamoRows) {
    it(row.name, async () => {
      const refusal = row.refusal();
      const { client } = dynamoRefusing(refusal);
      const adapter = new DynamoAdapter({ client, entities: { Row: { partitionKey: 'id' } } });
      await adapter.connect();
      try {
        const root = adapter.createDataSource('Row');
        await root.create({ id: 'u', version: 1 });
        await root.create({ id: 'd', version: 1 });
        const tx = await adapter.beginTransaction();
        const source = tx.createDataSource('Row');
        for (const write of row.writes) {
          await bufferDynamo(
            source,
            write,
            write === 'create' ? 'c' : write === 'update' ? 'u' : 'd',
          );
        }
        const error: unknown = await tx.commit().catch((caught: unknown) => caught);
        if (row.expected === 'unchanged') {
          expect(error).toBe(refusal);
        } else {
          expect(error).toBeInstanceOf(row.expected);
          expect((error as Error).cause).toBe(refusal);
        }
      } finally {
        await adapter.disconnect();
      }
    });
  }

  it('a plain buffered update whose row was deleted before commit is a serialization conflict', async () => {
    // The fixture evaluates the `attribute_exists` a plain buffered update
    // carries, so this is the store's own refusal rather than a scripted one.
    const adapter = new DynamoAdapter({
      client: dynamoFixture().client,
      entities: { Row: { partitionKey: 'id' } },
    });
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      await root.create({ id: 'a', version: 1 });
      const tx = await adapter.beginTransaction();
      await tx.createDataSource('Row').update('a', { version: 2 });
      await root.delete('a');
      const error: unknown = await tx.commit().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SerializationConflictError);
      expect(((error as Error).cause as Error).name).toBe('TransactionCanceledException');
      expect(await root.findById('a')).toBeNull();
    } finally {
      await adapter.disconnect();
    }
  });
});

describe('Cosmos commit failure mapping', () => {
  const make = (batchCode?: number) => {
    const fake = createFakeCosmosClient({
      containers: { Row: { partitionKeyPaths: ['/id'] } },
      ...(batchCode === undefined ? {} : { batchCode }),
    });
    return { fake, adapter: new CosmosAdapter({ database: 'db', client: fake.client }) };
  };

  it('a 412 batch failure is a serialization conflict carrying the batch error', async () => {
    const { adapter } = make();
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      await root.create({ id: 'a', version: 1 });
      const tx = await adapter.beginTransaction();
      await tx.createDataSource('Row').updateWhere!('a', { version: 1 }, { version: 2 });
      await root.update('a', { version: 3 });
      const error: unknown = await tx.commit().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SerializationConflictError);
      const cause = (error as Error).cause as Error & { code?: number };
      expect(cause.name).toBe('CosmosTransactionBatchError');
      expect(cause.code).toBe(412);
    } finally {
      await adapter.disconnect();
    }
  });

  it('a 409 batch failure keeps the batch error', async () => {
    const { adapter } = make();
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      const tx = await adapter.beginTransaction();
      await tx.createDataSource('Row').create({ id: 'a', version: 1 });
      await root.create({ id: 'a', version: 9 });
      const error: unknown = await tx.commit().catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(SerializationConflictError);
      expect((error as Error).name).toBe('CosmosTransactionBatchError');
      expect((error as Error & { code?: number }).code).toBe(409);
    } finally {
      await adapter.disconnect();
    }
  });

  it('another overall failure code keeps the batch error', async () => {
    const { adapter } = make(429);
    await adapter.connect();
    try {
      const tx = await adapter.beginTransaction();
      await tx.createDataSource('Row').create({ id: 'a', version: 1 });
      const error: unknown = await tx.commit().catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(SerializationConflictError);
      expect((error as Error).name).toBe('CosmosTransactionBatchError');
      expect((error as Error & { code?: number }).code).toBe(429);
    } finally {
      await adapter.disconnect();
    }
  });
});

describe('Bigtable commit failure mapping', () => {
  const make = () => {
    const store = new FakeBigtableStore();
    return {
      store,
      adapter: new BigtableAdapter({
        instance: 'i',
        client: createFakeBigtableClient(store),
        tables: { Row: {} },
      }),
    };
  };

  it('a predicate that no longer matches at commit is a serialization conflict', async () => {
    const { adapter } = make();
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      await root.create({ id: 'a', version: 1 });
      const tx = await adapter.beginTransaction();
      await tx.createDataSource('Row').updateWhere!('a', { version: 1 }, { version: 2 });
      await root.update('a', { version: 3 });
      const error: unknown = await tx.commit().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SerializationConflictError);
      expect((error as Error).cause).toBeInstanceOf(Error);
    } finally {
      await adapter.disconnect();
    }
  });

  it('a plain buffered update whose row was deleted before commit is a serialization conflict', async () => {
    const { adapter } = make();
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      await root.create({ id: 'a', version: 1 });
      const tx = await adapter.beginTransaction();
      await tx.createDataSource('Row').update('a', { version: 2 });
      await root.delete('a');
      const error: unknown = await tx.commit().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SerializationConflictError);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(await root.findById('a')).toBeNull();
    } finally {
      await adapter.disconnect();
    }
  });

  it('a buffered create whose row appeared before commit stays a duplicate key', async () => {
    const { adapter } = make();
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      const tx = await adapter.beginTransaction();
      await tx.createDataSource('Row').create({ id: 'a', version: 1 });
      await root.create({ id: 'a', version: 9 });
      const error: unknown = await tx.commit().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DuplicateKeyError);
      expect(error).not.toBeInstanceOf(SerializationConflictError);
    } finally {
      await adapter.disconnect();
    }
  });
});

/** One store's adapter plus a counter of every committed read it issued. */
interface ScopeBackend {
  readonly name: string;
  readonly refusal: ErrorClass;
  readonly make: () => {
    adapter: DynamoAdapter | CosmosAdapter | BigtableAdapter;
    reads: () => number;
  };
}

const scopeBackends: readonly ScopeBackend[] = [
  {
    name: 'dynamodb',
    refusal: UnsupportedQueryFeatureError,
    make: () => {
      const fixture = dynamoFixture();
      let reads = 0;
      const count =
        <A extends unknown[], R>(run: (...args: A) => R) =>
        (...args: A): R => {
          reads += 1;
          return run(...args);
        };
      const client: IDynamoClient = {
        ...fixture.client,
        getItem: count(fixture.client.getItem),
        query: count(fixture.client.query),
        scan: count(fixture.client.scan),
      };
      return {
        adapter: new DynamoAdapter({ client, entities: { Row: { partitionKey: 'id' } } }),
        reads: () => reads,
      };
    },
  },
  {
    name: 'cosmos',
    refusal: CosmosTransactionScopeError,
    make: () => {
      let pointReads = 0;
      const fake = createFakeCosmosClient({
        containers: { Row: { partitionKeyPaths: ['/id'] } },
        afterPointRead: () => {
          pointReads += 1;
        },
      });
      return {
        adapter: new CosmosAdapter({ database: 'db', client: fake.client }),
        reads: () => pointReads + fake.recorder.queries.length,
      };
    },
  },
  {
    name: 'bigtable',
    refusal: BigtableTransactionScopeError,
    make: () => {
      const store = new FakeBigtableStore();
      return {
        adapter: new BigtableAdapter({
          instance: 'i',
          client: createFakeBigtableClient(store),
          tables: { Row: {} },
        }),
        reads: () => store.reads.length,
      };
    },
  },
];

const earlierWrites: readonly DynamoWrite[] = ['create', 'update', 'delete'];
const conditionalWrites = ['updateWhere', 'deleteWhere'] as const;

for (const backend of scopeBackends) {
  describe(`${backend.name}: an earlier write, then a conditional write to the same row`, () => {
    for (const earlier of earlierWrites) {
      for (const conditional of conditionalWrites) {
        it(`${earlier} then ${conditional} is refused by name before any read`, async () => {
          const { adapter, reads } = backend.make();
          await adapter.connect();
          try {
            const root = adapter.createDataSource('Row');
            if (earlier !== 'create') await root.create({ id: 'a', version: 1 });
            const tx = await adapter.beginTransaction();
            const source = tx.createDataSource('Row');
            await bufferDynamo(source, earlier, 'a');
            const before = reads();
            const attempt =
              conditional === 'updateWhere'
                ? source.updateWhere!('a', { version: 1 }, { version: 5 })
                : source.deleteWhere!('a', { version: 1 });
            await expect(attempt).rejects.toBeInstanceOf(backend.refusal);
            expect(reads()).toBe(before);
            await tx.rollback();
          } finally {
            await adapter.disconnect();
          }
        });
      }
    }
  });
}
