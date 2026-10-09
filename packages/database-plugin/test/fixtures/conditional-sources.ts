import type { IDataSource } from '@setu-ts/common';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { createPrismaDataSource } from '../../src/adapters/prisma/prisma-adapter.ts';
import {
  createDrizzleDataSource,
  type DrizzleOperators,
} from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createMongoDataSource } from '../../src/adapters/mongo/mongo-data-source.ts';
import { createCosmosDataSource } from '../../src/adapters/cosmos/cosmos-data-source.ts';
import { resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { PartitionKeyResolver } from '../../src/adapters/cosmos/cosmos-partition-key.ts';
import { createBigtableDataSource } from '../../src/adapters/bigtable/bigtable-data-source.ts';
import { resolveBigtableTarget } from '../../src/adapters/bigtable/bigtable-mapping.ts';
import { createFakePrismaClient } from './fake-prisma-client.ts';
import { createFakeDrizzleInstance, createFakeDrizzleTable } from './fake-drizzle-instance.ts';
import { FakeMongoClient } from './fake-mongo-client.ts';
import { createFakeCosmosClient } from './fake-cosmos-client.ts';
import { createFakeBigtableClient, FakeBigtableStore } from './fake-bigtable-client.ts';
import { createD1DataSource } from '../../../cloudflare-plugin/src/database/d1-data-source.ts';
import { SqliteD1 } from '../../../cloudflare-plugin/test/d1-fakes.ts';

import { dynamoFixture } from './conditional-dynamo.ts';

export const operators: DrizzleOperators = {
  eq: (col, val) => ({ op: 'eq', col, val }),
  and: (...exprs) => ({ op: 'and', exprs }),
  asc: (col) => ({ op: 'asc', col }),
  desc: (col) => ({ op: 'desc', col }),
  count: () => ({ op: 'count' }),
};
export const sources: readonly {
  name: string;
  unknown: 'throws' | 'not-matched';
  make: () => IDataSource;
}[] = [
  { name: 'dynamodb', unknown: 'not-matched', make: () => dynamoFixture().source },
  {
    name: 'memory',
    unknown: 'not-matched',
    make: () => new MemoryAdapter().createDataSource('User'),
  },
  {
    name: 'prisma',
    unknown: 'not-matched',
    make: () => createPrismaDataSource(createFakePrismaClient(), 'User'),
  },
  {
    name: 'drizzle',
    unknown: 'throws',
    make: () =>
      createDrizzleDataSource(createFakeDrizzleInstance(), 'user', {
        user: createFakeDrizzleTable('user'),
      }, operators),
  },
  {
    name: 'mongodb',
    unknown: 'not-matched',
    make: () => createMongoDataSource(new FakeMongoClient(), 'db', 'User', undefined),
  },
  {
    name: 'cosmos',
    unknown: 'not-matched',
    make: () => {
      const database = createFakeCosmosClient({
        containers: { User: { partitionKeyPaths: ['/id'] } },
      }).client.database('db');
      return createCosmosDataSource({
        database,
        target: resolveCosmosTarget('User', undefined),
        partitionKeys: new PartitionKeyResolver(database),
      });
    },
  },
  {
    name: 'bigtable',
    unknown: 'not-matched',
    make: () => {
      const table = createFakeBigtableClient(new FakeBigtableStore()).instance('i').table('User');
      return createBigtableDataSource(table, resolveBigtableTarget('User', undefined));
    },
  },
  {
    name: 'd1',
    unknown: 'throws',
    make: () =>
      createD1DataSource(
        new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT)'),
        { table: 'users', primaryKey: ['id'] },
      ),
  },
];
