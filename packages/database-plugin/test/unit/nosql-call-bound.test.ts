import { describe, expect, it } from 'vitest';
import {
  BigtableAdapter,
  CosmosAdapter,
  DynamoAdapter,
  DatabaseTimeoutError,
} from '../../src/index.ts';
import type { IDataSource, NormalizedQuery } from '@setu-ts/common';
import { deadlineRangeError } from '@setu-ts/common';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';
import { dynamoFixture } from '../fixtures/conditional-dynamo.ts';
import { frozenFacade } from '../fixtures/frozen-facade.ts';
import {
  isDatabaseTimeout,
  requestBound,
  requestTimeout,
} from '../../src/adapters/request-bound.ts';

const query: NormalizedQuery = { where: {}, orderBy: {}, offset: 0, limit: 2, select: [] };
function fixture(type: string, timeout?: number) {
  const options = timeout === undefined ? {} : { requestTimeoutMs: timeout };
  if (type === 'dynamodb') {
    const fake = frozenFacade(dynamoFixture().client);
    return {
      ...fake,
      adapter: new DynamoAdapter({
        client: fake.client,
        entities: { Row: { partitionKey: 'id' } },
        ...options,
      }),
    };
  }
  if (type === 'cosmos') {
    const fake = frozenFacade(
      createFakeCosmosClient({ containers: { Row: { partitionKeyPaths: ['/id'] } } }).client,
    );
    return {
      ...fake,
      adapter: new CosmosAdapter({ database: 'db', client: fake.client, ...options }),
    };
  }
  const fake = frozenFacade(createFakeBigtableClient(new FakeBigtableStore()));
  return {
    ...fake,
    adapter: new BigtableAdapter({
      instance: 'i',
      client: fake.client,
      tables: { Row: {} },
      ...options,
    }),
  };
}

for (const type of ['dynamodb', 'cosmos', 'bigtable'])
  describe(`${type} cancelling call bound`, () => {
    for (const [name, operation] of [
      ['point read', (source: IDataSource) => source.findById('a')],
      ['page', (source: IDataSource) => source.findPage!(query)],
      ['create', (source: IDataSource) => source.create({ id: 'b', version: 1 })],
      ['update', (source: IDataSource) => source.update('a', { version: 2 })],
      ['delete', (source: IDataSource) => source.delete('a')],
      [
        'conditional update',
        (source: IDataSource) => source.updateWhere!('a', { version: 1 }, { version: 2 }),
      ],
      ['conditional delete', (source: IDataSource) => source.deleteWhere!('a', { version: 1 })],
      ['count', (source: IDataSource) => source.count({})],
    ] as const)
      it(`ends a frozen ${name} with a 504 and preserves its cause`, async () => {
        const f = fixture(type, 20);
        await f.adapter.connect();
        try {
          const source = f.adapter.createDataSource('Row');
          await source.create({ id: 'a', version: 1 });
          await source.findById('a');
          f.freeze();
          const failure: unknown = await operation(source).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(DatabaseTimeoutError);
          expect((failure as Error).cause).toBeDefined();
        } finally {
          await f.adapter.disconnect();
        }
      }, 1000);
    it('bounds the commit batch and leaves zero disabled without a signal or timeout', async () => {
      const f = fixture(type, 20);
      await f.adapter.connect();
      try {
        const source = f.adapter.createDataSource('Row');
        await source.create({ id: 'a', version: 1 });
        await source.findById('a');
        const tx = await f.adapter.beginTransaction();
        await tx.createDataSource('Row').create({ id: 'b', version: 1 });
        f.freeze();
        await expect(tx.commit()).rejects.toBeInstanceOf(DatabaseTimeoutError);
      } finally {
        await f.adapter.disconnect();
      }
      const disabled = fixture(type, 0);
      await disabled.adapter.connect();
      try {
        await disabled.adapter.createDataSource('Row').findById('a');
        expect(disabled.calls.length).toBeGreaterThan(0);
        for (const call of disabled.calls) {
          expect(call.options.abortSignal).toBeUndefined();
          expect(call.options.timeoutMs).toBeUndefined();
        }
      } finally {
        await disabled.adapter.disconnect();
      }
    });
    it('uses the exact common range rule and accepts fractional milliseconds', () => {
      for (const value of [-1, NaN, Infinity, 2147483648]) {
        expect(() => fixture(type, value)).toThrow(
          deadlineRangeError('requestTimeoutMs', value)!.message,
        );
      }
      expect(() => fixture(type, 1500.5)).not.toThrow();
    });
  });
describe('shared deadline rules', () => {
  it('keeps the default and propagates non-expiry failures, including disabled grpc deadlines', async () => {
    expect(requestTimeout(undefined)).toBe(15_000);
    const error = Object.assign(new Error('fault'), { code: 4 });
    await expect(requestBound(0, () => Promise.reject(error), true)).rejects.toBe(error);
    await expect(requestBound(10, () => Promise.reject(error))).rejects.toBe(error);
    expect(await requestBound(0.5, () => Promise.resolve('ok'))).toBe('ok');
  });
});

describe('cosmos metadata reads under the call bound', () => {
  it('keeps a frozen container-definition read a 504 on the first call', async () => {
    const f = fixture('cosmos', 20);
    await f.adapter.connect();
    try {
      f.freeze();
      await expect(f.adapter.createDataSource('Row').findById('a')).rejects.toBeInstanceOf(
        DatabaseTimeoutError,
      );
    } finally {
      await f.adapter.disconnect();
    }
  }, 1000);
  it('keeps a frozen database read at connect a 504', async () => {
    const f = fixture('cosmos', 20);
    f.freeze();
    await expect(f.adapter.connect()).rejects.toBeInstanceOf(DatabaseTimeoutError);
  }, 1000);
});

describe('isDatabaseTimeout', () => {
  it('answers false for a value whose prototype read throws', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(isDatabaseTimeout(proxy)).toBe(false);
    expect(isDatabaseTimeout(new DatabaseTimeoutError('x'))).toBe(true);
  });
});

describe('a driver wait that ignores the signal', () => {
  it('still ends the call at the bound with a 504, and 0 still waits it out', async () => {
    const ignoring = (ms: number) => () =>
      new Promise<string>((resolve) => setTimeout(() => resolve('late'), ms));
    const started = performance.now();
    const error: unknown = await requestBound(30, ignoring(500)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatabaseTimeoutError);
    expect(((error as Error).cause as Error).name).toBe('TimeoutError');
    expect(performance.now() - started).toBeLessThan(300);
    expect(await requestBound(0, ignoring(20))).toBe('late');
  });

  it('bounds the Cosmos readiness read through a throttle retry-after the SDK sleeps through', async () => {
    const fake = createFakeCosmosClient({ containers: { Row: { partitionKeyPaths: ['/id'] } } });
    let throttled = false;
    const client = {
      ...fake.client,
      database: (name: string) => {
        const database = fake.client.database(name);
        return Object.assign(Object.create(database) as typeof database, {
          // The SDK's retry sleep: a bare timer that never reads the signal.
          read: (options?: Parameters<typeof database.read>[0]) =>
            throttled
              ? new Promise<Awaited<ReturnType<typeof database.read>>>((resolve) =>
                  setTimeout(() => resolve(database.read(options)), 1000),
                )
              : database.read(options),
        });
      },
    };
    const adapter = new CosmosAdapter({ database: 'db', client, requestTimeoutMs: 50 });
    await adapter.connect();
    try {
      throttled = true;
      const started = performance.now();
      await expect(adapter.isHealthy()).rejects.toBeInstanceOf(DatabaseTimeoutError);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      await adapter.disconnect();
    }
  });
});
