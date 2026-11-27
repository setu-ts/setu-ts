/**
 * The `database` indicator's M101a mapping, as data (plan §6): each row is a
 * probe answer, a pool snapshot and a query-progress reading, and the status
 * the indicator must report for them. Driven through the `type: 'custom'` arm
 * with a fake adapter carrying the three seams the plugin feature-detects, so
 * no row depends on a Drizzle driver.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type {
  IAdapterTransaction,
  IDatabaseAdapter,
  IDataSource,
  IPluginContext,
} from '@setu-ts/common';

import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import {
  DATABASE_POOL_CAPACITY,
  DATABASE_QUERY_PROGRESS,
} from '../../src/health/database-capacity.ts';
import type { DatabasePoolCapacity } from '../../src/interfaces/index.ts';
import { BigtableAdapter, CosmosAdapter, DynamoAdapter } from '../../src/index.ts';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import type { IBigtableClient } from '../../src/adapters/bigtable/bigtable-client-types.ts';
import type { ICosmosClient } from '../../src/adapters/cosmos/cosmos-client-types.ts';
import { dynamoFixture } from '../fixtures/conditional-dynamo.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';
import { createFakeCosmosClient, FakeCosmosError } from '../fixtures/fake-cosmos-client.ts';

const SATURATED: DatabasePoolCapacity = { total: 4, idle: 0, waiting: 3 };
const IDLE: DatabasePoolCapacity = { total: 4, idle: 2, waiting: 0 };

/** One mapping row: what the adapter reports, and the status it must read as. */
interface Row {
  readonly name: string;
  /** `'reject'` makes the probe produce no answer (`reachable` undefined). */
  readonly probe: boolean | 'reject';
  readonly capacity: DatabasePoolCapacity | undefined;
  /** Completed-query counts the adapter reports on successive reads. */
  readonly completed: ReadonlyArray<number | null> | undefined;
  readonly status: 'up' | 'degraded' | 'down';
  readonly reachable: true | false | 'unknown';
}

const ROWS: ReadonlyArray<Row> = [
  {
    name: 'no answer + saturated + queries completing → up',
    probe: 'reject',
    capacity: SATURATED,
    completed: [5, 6],
    status: 'up',
    reachable: 'unknown',
  },
  {
    name: 'no answer + saturated + no query completed → degraded (a hung database)',
    probe: 'reject',
    capacity: SATURATED,
    completed: [0, 0],
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'no answer + saturated + no progress seam → degraded',
    probe: 'reject',
    capacity: SATURATED,
    completed: undefined,
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'no answer + saturated + progress unobservable (typed seam in use) → up',
    probe: 'reject',
    capacity: SATURATED,
    completed: [null, null],
    status: 'up',
    reachable: 'unknown',
  },
  {
    name: 'no answer + idle capacity + progress unobservable → degraded',
    probe: 'reject',
    capacity: IDLE,
    completed: [null, null],
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'no answer + idle capacity → degraded',
    probe: 'reject',
    capacity: IDLE,
    completed: [5, 6],
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'no answer + no capacity → degraded',
    probe: 'reject',
    capacity: undefined,
    completed: [5, 6],
    status: 'degraded',
    reachable: 'unknown',
  },
  {
    name: 'refused + saturated → down (a refused probe is still a refusal)',
    probe: false,
    capacity: SATURATED,
    completed: [5, 6],
    status: 'down',
    reachable: false,
  },
  {
    name: 'answered + saturated → up',
    probe: true,
    capacity: SATURATED,
    completed: [0, 0],
    status: 'up',
    reachable: true,
  },
];

function emptySource(): IDataSource {
  return {
    findAll: () => Promise.resolve([]),
    findById: () => Promise.resolve(null),
    create: (data) => Promise.resolve({ ...data } as Record<string, unknown>),
    update: (_id, data) => Promise.resolve({ ...data } as Record<string, unknown>),
    delete: () => Promise.resolve(true),
    count: () => Promise.resolve(0),
  };
}

/** A backend reporting exactly what a row describes. */
function adapterFor(row: Row): IDatabaseAdapter {
  const counts = [...(row.completed ?? [])];
  const adapter: IDatabaseAdapter & {
    [DATABASE_POOL_CAPACITY]?: () => DatabasePoolCapacity;
    [DATABASE_QUERY_PROGRESS]?: () => number | null;
  } = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    isReady: () => true,
    isHealthy: () =>
      row.probe === 'reject'
        ? Promise.reject(new Error('probe did not answer'))
        : Promise.resolve(row.probe),
    createDataSource: () => emptySource(),
    beginTransaction: (): Promise<IAdapterTransaction> =>
      Promise.resolve({
        createDataSource: () => emptySource(),
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
      }),
    rawQuery: <T>(): Promise<T[]> => Promise.resolve([]),
  };
  if (row.capacity !== undefined) {
    const capacity = row.capacity;
    adapter[DATABASE_POOL_CAPACITY] = () => capacity;
  }
  if (row.completed !== undefined) {
    // Each read consumes the next count; the last one repeats.
    adapter[DATABASE_QUERY_PROGRESS] = () => (counts.length > 1 ? counts.shift()! : counts[0]!);
  }
  return adapter;
}

async function indicatorFor(row: Row) {
  return await indicatorForAdapter(adapterFor(row));
}

async function indicatorForAdapter(adapter: IDatabaseAdapter) {
  let indicator: (() => Promise<{ status: string; data?: Record<string, unknown> }>) | undefined;
  let clock = 0;
  const ctx = {
    services: { has: () => false, get: () => undefined, register: () => {} },
    health: {
      register: (_name: string, fn: typeof indicator) => {
        indicator = fn;
      },
    },
    lifecycle: { onClose: () => {} },
    runtime: {
      // Each read advances 1 s: well inside the 10-second progress window.
      hrtime: () => (clock += 1000),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  } as unknown as IPluginContext;
  await DatabasePlugin({ type: 'custom', adapter }).register(ctx);
  return indicator!;
}

describe('database indicator mapping (M101a)', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const indicator = await indicatorFor(row);
      const health = await indicator();
      expect(health.status).toBe(row.status);
      expect(health.data?.['reachable']).toBe(row.reachable);
    });
  }
});

/** How the store answers the readiness probe once the adapter is connected. */
type ProbeAnswer = 'answered' | 'refused' | 'unknown';

/** A NoSQL adapter whose probe answer is switched after connect (the connect read stays healthy). */
interface NoSqlBackend {
  readonly name: string;
  readonly make: (answer: () => ProbeAnswer) => IDatabaseAdapter;
}

const NOSQL_BACKENDS: ReadonlyArray<NoSqlBackend> = [
  {
    name: 'dynamodb',
    make: (answer) => {
      const inner = dynamoFixture().client;
      const client: IDynamoClient = {
        ...inner,
        getItem: (input, options) => {
          const now = answer();
          if (now === 'refused') {
            return Promise.reject(
              Object.assign(new Error('no table'), { name: 'ResourceNotFoundException' }),
            );
          }
          if (now === 'unknown') {
            return Promise.reject(Object.assign(new Error('odd'), { name: 'InternalOddity' }));
          }
          return inner.getItem(input, options);
        },
      };
      return new DynamoAdapter({ client, entities: { Row: { partitionKey: 'id' } } });
    },
  },
  {
    name: 'cosmos',
    make: (answer) => {
      const inner = createFakeCosmosClient({ containers: {} }).client;
      const client: ICosmosClient = {
        database: (id) => {
          const database = inner.database(id);
          return {
            container: (name) => database.container(name),
            read: (options) => {
              const now = answer();
              if (now === 'refused') return Promise.reject(new FakeCosmosError(403, 'forbidden'));
              if (now === 'unknown') return Promise.reject(new FakeCosmosError(400, 'odd'));
              return database.read(options);
            },
          };
        },
      };
      return new CosmosAdapter({ client, database: 'app' });
    },
  },
  {
    name: 'bigtable',
    make: (answer) => {
      const inner = createFakeBigtableClient(new FakeBigtableStore());
      const client: IBigtableClient = {
        instance: (id) => ({
          table: (table) => {
            const handle = inner.instance(id).table(table);
            return {
              row: (key) => handle.row(key),
              readRows: (options, callOptions) => {
                const now = answer();
                if (now === 'refused') {
                  return Promise.reject(Object.assign(new Error('not found'), { code: 5 }));
                }
                if (now === 'unknown') {
                  return Promise.reject(Object.assign(new Error('odd'), { code: 3 }));
                }
                return handle.readRows(options, callOptions);
              },
            };
          },
        }),
        close: () => inner.close(),
      };
      return new BigtableAdapter({ client, instance: 'app', tables: { Row: {} } });
    },
  },
];

const NOSQL_ROWS: ReadonlyArray<{
  readonly answer: ProbeAnswer;
  readonly status: 'up' | 'degraded' | 'down';
  readonly reachable: true | false | 'unknown';
}> = [
  { answer: 'answered', status: 'up', reachable: true },
  { answer: 'refused', status: 'down', reachable: false },
  { answer: 'unknown', status: 'degraded', reachable: 'unknown' },
];

describe('database indicator mapping: the NoSQL adapters report reachable', () => {
  for (const backend of NOSQL_BACKENDS) {
    for (const row of NOSQL_ROWS) {
      it(`${backend.name}: a probe that is ${row.answer} → ${row.status}`, async () => {
        let current: ProbeAnswer = 'answered';
        const indicator = await indicatorForAdapter(backend.make(() => current));
        current = row.answer;
        const health = await indicator();
        expect(health.status).toBe(row.status);
        expect(health.data?.['reachable']).toBe(row.reachable);
      });
    }
  }
});
