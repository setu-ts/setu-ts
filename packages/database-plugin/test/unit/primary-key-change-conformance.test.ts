import { describe, expect, it } from 'vitest';
import { PrimaryKeyChangeError } from '@setu-ts/common';
import { sources } from '../fixtures/conditional-sources.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { IDatabaseAdapter } from '@setu-ts/common';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { MongoAdapter } from '../../src/adapters/mongo/mongo-adapter.ts';
import { CosmosAdapter } from '../../src/adapters/cosmos/cosmos-adapter.ts';
import { BigtableAdapter } from '../../src/adapters/bigtable/bigtable-adapter.ts';
import { DynamoAdapter } from '../../src/adapters/dynamo/dynamo-adapter.ts';
import { createDrizzleDatabase } from '../../src/index.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';
import { FakeMongoClient } from '../fixtures/fake-mongo-client.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';
import { dynamoFixture } from '../fixtures/conditional-dynamo.ts';
import { D1Adapter } from '../../../cloudflare-plugin/src/database/d1-adapter.ts';
import { SqliteD1 } from '../../../cloudflare-plugin/test/d1-fakes.ts';

for (const fixture of sources) {
  describe(`${fixture.name} primary key immutability`, () => {
    for (const safeReads of [1, 2]) {
      for (const proxy of [false, true]) {
        it(`update snapshots a ${proxy ? 'Proxy' : 'getter'} payload once (${safeReads} safe reads)`, async () => {
          const source = fixture.make();
          await source.create({ id: '5', name: 'before' });
          let reads = 0;
          const payload = {
            get id() {
              reads += 1;
              return reads <= safeReads ? '5' : 'private-new';
            },
            name: 'after',
          };
          await source.update('5', proxy ? new Proxy(payload, {}) : payload);
          expect(await source.findById('5')).toMatchObject({ id: '5', name: 'after' });
          expect(await source.findById('private-new')).toBeNull();
          expect(reads).toBe(1);
        });
      }
    }
    for (const operation of ['update', 'updateWhere'] as const) {
      it(`${operation} refuses a changed key before a write and leaves the row unmoved`, async () => {
        const calls: string[] = [];
        const source = fixture.make(calls);
        await source.create({ id: '5', role: 'before', name: 'original' });
        calls.length = 0;
        const call = () =>
          operation === 'update'
            ? source.update('5', { id: 'private-new', role: 'after' })
            : source.updateWhere!('5', { role: 'before' }, { id: 'private-new', role: 'after' });
        let promise: ReturnType<typeof call> | undefined;
        expect(() => {
          promise = call();
        }).not.toThrow();
        await expect(promise).rejects.toBeInstanceOf(PrimaryKeyChangeError);
        expect(calls).toEqual([]);
        expect(await source.findById('5')).toMatchObject({ id: '5', role: 'before' });
        expect(await source.findById('private-new')).toBeNull();
      });
      it(`${operation} accepts an equal key including route-string/body-number equality`, async () => {
        const calls: string[] = [];
        const source = fixture.make(calls);
        await source.create({ id: '5', role: 'before', name: 'original' });
        const updated =
          operation === 'update'
            ? await source.update('5', { id: 5, role: 'after' })
            : await source.updateWhere!('5', { role: 'before' }, { id: 5, role: 'after' });
        expect(updated).toMatchObject({ role: 'after' });
        if (fixture.name === 'memory') expect(updated?.['id']).toBe('5');
      });
    }
  });
}

it('Memory transaction refuses changed keys and preserves the stored key type', async () => {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  await adapter.createDataSource('User').create({ id: '5', role: 'before' });
  const tx = await adapter.beginTransaction();
  const source = tx.createDataSource('User');
  await expect(source.update('5', { id: 'changed' })).rejects.toBeInstanceOf(PrimaryKeyChangeError);
  expect((await source.update('5', { id: 5, role: 'after' }))['id']).toBe('5');
  await tx.commit();
  expect(await adapter.createDataSource('User').findById('5')).toMatchObject({
    id: '5',
    role: 'after',
  });
});

const transactionAdapters: readonly { name: string; make: () => IDatabaseAdapter }[] = [
  { name: 'memory', make: () => new MemoryAdapter() },
  {
    name: 'prisma',
    make: () =>
      new PrismaAdapter({ prismaClient: createFakePrismaClient(), provider: 'postgresql' }),
  },
  {
    name: 'drizzle',
    make: () =>
      new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(createFakeDrizzleInstance(), (db, work) =>
          db.transaction(work),
        ),
        drizzleTables: { User: createFakeDrizzleTable('user') },
      }),
  },
  {
    name: 'mongodb',
    make: () => new MongoAdapter({ client: new FakeMongoClient(), database: 'db' }),
  },
  {
    name: 'cosmos',
    make: () =>
      new CosmosAdapter({
        database: 'db',
        client: createFakeCosmosClient({ containers: { User: { partitionKeyPaths: ['/id'] } } })
          .client,
      }),
  },
  {
    name: 'bigtable',
    make: () =>
      new BigtableAdapter({
        client: createFakeBigtableClient(new FakeBigtableStore()),
        instance: 'i',
      }),
  },
  {
    name: 'dynamodb',
    make: () =>
      new DynamoAdapter({
        client: dynamoFixture().client,
        entities: { User: { partitionKey: 'id' } },
      }),
  },
  {
    name: 'd1',
    make: () =>
      new D1Adapter(new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)'), {
        tables: { User: { table: 'users' } },
      }),
  },
];
for (const fixture of transactionAdapters) {
  it(`${fixture.name} transaction snapshots a getter payload once (two safe reads)`, async () => {
    const adapter = fixture.make();
    await adapter.connect();
    const committed = adapter.createDataSource('User');
    await committed.create({ id: '5', name: 'before' });
    const tx = await adapter.beginTransaction();
    try {
      let reads = 0;
      const updated = await tx.createDataSource('User').update('5', {
        get id() {
          reads += 1;
          return reads <= 2 ? '5' : 'private-new';
        },
        name: 'after',
      });
      expect(updated).toMatchObject({ id: '5', name: 'after' });
      await tx.commit();
      // Cosmos/Dynamo transaction fixtures record batches without applying them;
      // the returned patch and the committed row must both retain the key.
      expect(await committed.findById('5')).toMatchObject({ id: '5' });
      expect(await committed.findById('private-new')).toBeNull();
      expect(reads).toBe(1);
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      await adapter.disconnect();
    }
  });
  it(`${fixture.name} transaction refuses key changes before recording writes`, async () => {
    const adapter = fixture.make();
    await adapter.connect();
    const committed = adapter.createDataSource('User');
    await committed.create({ id: '5', name: 'before' });
    const tx = await adapter.beginTransaction();
    try {
      const source = tx.createDataSource('User');
      await expect(source.update('5', { id: 'new', name: 'after' })).rejects.toBeInstanceOf(
        PrimaryKeyChangeError,
      );
      if (source.updateWhere !== undefined)
        await expect(
          source.updateWhere('5', { name: 'before' }, { id: 'new' }),
        ).rejects.toBeInstanceOf(PrimaryKeyChangeError);
      await tx.commit();
      expect(await committed.findById('5')).toMatchObject({ id: '5', name: 'before' });
      expect(await committed.findById('new')).toBeNull();
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      await adapter.disconnect();
    }
  });
}
