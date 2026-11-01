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

import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
import { dynamoFixture } from './conditional-dynamo.ts';

/** The fake Drizzle expression grammar, evaluated by the recording instance. */
export const operators: DrizzleOperators = {
  eq: (col, val) => ({ op: 'eq', col, val }),
  and: (...exprs) => ({ op: 'and', exprs }),
  asc: (col) => ({ op: 'asc', col }),
  desc: (col) => ({ op: 'desc', col }),
  count: () => ({ op: 'count' }),
};
/** Public data-source factories and their native unknown-column outcomes. */
export const sources: readonly {
  name: string;
  unknown: 'throws' | 'not-matched';
  make: (calls?: string[]) => IDataSource;
}[] = [
  {
    name: 'dynamodb',
    unknown: 'not-matched',
    make: (calls) =>
      createDynamoDataSource(observe(dynamoFixture().client, calls), 'User', {
        User: { partitionKey: 'id' },
      }),
  },
  {
    name: 'memory',
    unknown: 'not-matched',
    make: () => new MemoryAdapter().createDataSource('User'),
  },
  {
    name: 'prisma',
    unknown: 'throws',
    make: (calls) => {
      const client = createFakePrismaClient();
      // Prisma has a schema: an unknown field is validation failure, not P2025.
      const validate = (where: Record<string, unknown>): void => {
        for (const [field, value] of Object.entries(where)) {
          if (field === 'AND') {
            for (const clause of value as Record<string, unknown>[]) validate(clause);
          } else if (!['id', 'role', 'name', 'version'].includes(field)) {
            // Real Prisma's validation error is named so and renders the
            // whole query, values included — which is what M105 must not echo.
            const error = new Error(
              `Unknown argument \`${field}\`. User.update ${JSON.stringify(where)}`,
            );
            error.name = 'PrismaClientValidationError';
            throw error;
          }
        }
      };
      const update = client.user.update.bind(client.user);
      const remove = client.user.delete.bind(client.user);
      client.user.update = async (args) => {
        validate(args.where);
        return await update(args);
      };
      client.user.delete = async (args) => {
        validate(args.where);
        return await remove(args);
      };
      return createPrismaDataSource(observe(client, calls), 'User');
    },
  },
  {
    name: 'drizzle',
    unknown: 'throws',
    make: (calls) =>
      createDrizzleDataSource(
        observe(createFakeDrizzleInstance(), calls),
        'user',
        {
          user: createFakeDrizzleTable('user'),
        },
        operators,
      ),
  },
  {
    name: 'mongodb',
    unknown: 'not-matched',
    make: (calls) =>
      createMongoDataSource(observe(new FakeMongoClient(), calls), 'db', 'User', undefined),
  },
  {
    name: 'cosmos',
    unknown: 'not-matched',
    make: (calls) => {
      const database = createFakeCosmosClient({
        containers: { User: { partitionKeyPaths: ['/id'] } },
      }).client.database('db');
      return createCosmosDataSource({
        database: observe(database, calls),
        target: resolveCosmosTarget('User', undefined),
        partitionKeys: new PartitionKeyResolver(database),
      });
    },
  },
  {
    name: 'bigtable',
    unknown: 'not-matched',
    make: (calls) => {
      const table = createFakeBigtableClient(new FakeBigtableStore()).instance('i').table('User');
      return createBigtableDataSource(
        observe(table, calls),
        resolveBigtableTarget('User', undefined),
      );
    },
  },
  {
    name: 'd1',
    unknown: 'throws',
    make: (calls) =>
      createD1DataSource(
        observe(
          new SqliteD1(
            'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, version INTEGER)',
          ),
          calls,
        ),
        { entity: 'users', table: 'users', primaryKey: ['id'] },
      ),
  },
];

/** Record actual native facade calls; promise results and row data are not proxied. */
function observe<T extends object>(target: T, calls: string[] | undefined): T {
  if (calls === undefined) return target;
  return new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value === 'function')
        return (...args: unknown[]): unknown => {
          calls.push(String(property));
          const result: unknown = Reflect.apply(value, object, args);
          return typeof result === 'object' && result !== null && !(result instanceof Promise)
            ? observe(result, calls)
            : result;
        };
      return typeof value === 'object' && value !== null ? observe(value, calls) : value;
    },
  });
}
