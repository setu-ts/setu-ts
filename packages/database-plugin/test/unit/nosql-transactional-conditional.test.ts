import { describe, expect, it } from 'vitest';
import {
  BigtableAdapter,
  CosmosAdapter,
  DynamoAdapter,
  SerializationConflictError,
} from '../../src/index.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';
import { dynamoFixture } from '../fixtures/conditional-dynamo.ts';

export const transactionalNoSql = [
  {
    name: 'dynamodb',
    make: () =>
      new DynamoAdapter({
        client: dynamoFixture().client,
        entities: { Row: { partitionKey: 'id' } },
      }),
  },
  {
    name: 'cosmos',
    make: () =>
      new CosmosAdapter({
        database: 'db',
        client: createFakeCosmosClient({ containers: { Row: { partitionKeyPaths: ['/id'] } } })
          .client,
      }),
  },
  {
    name: 'bigtable',
    make: () =>
      new BigtableAdapter({
        instance: 'i',
        client: createFakeBigtableClient(new FakeBigtableStore()),
        tables: { Row: {} },
      }),
  },
];

for (const backend of transactionalNoSql)
  describe(`${backend.name} transactional conditionals`, () => {
    for (const operation of ['update', 'delete'] as const) {
      it(`${operation}: returns misses without buffering and commits a matching precondition`, async () => {
        const adapter = backend.make();
        await adapter.connect();
        try {
          const root = adapter.createDataSource('Row');
          await root.create({ id: 'a', version: 1, name: 'old' });
          const tx = await adapter.beginTransaction();
          const source = tx.createDataSource('Row');
          expect(await source.updateWhere!('a', { version: 0 }, { name: 'bad' })).toBeNull();
          expect(await source.deleteWhere!('missing', { version: 1 })).toBe(false);
          const result =
            operation === 'update'
              ? await source.updateWhere!('a', { version: 1 }, { version: 2, name: 'new' })
              : await source.deleteWhere!('a', { version: 1 });
          expect(result).toEqual(
            operation === 'update' ? { id: 'a', version: 2, name: 'new' } : true,
          );
          expect(await root.findById('a')).toEqual({ id: 'a', version: 1, name: 'old' });
          await tx.commit();
          expect(await root.findById('a')).toEqual(
            operation === 'update' ? { id: 'a', version: 2, name: 'new' } : null,
          );
        } finally {
          await adapter.disconnect();
        }
      });
      it(`${operation}: refuses a lost precondition at commit with 409 and preserves the winner`, async () => {
        const adapter = backend.make();
        await adapter.connect();
        try {
          const root = adapter.createDataSource('Row');
          await root.create({ id: 'a', version: 1 });
          const tx = await adapter.beginTransaction();
          const source = tx.createDataSource('Row');
          if (operation === 'update')
            await source.updateWhere!('a', { version: 1 }, { version: 2 });
          else await source.deleteWhere!('a', { version: 1 });
          await root.update('a', { version: 3 });
          const error: unknown = await tx.commit().catch((error: unknown) => error);
          expect(error).toBeInstanceOf(SerializationConflictError);
          expect((error as Error).cause).toBeDefined();
          expect(await root.findById('a')).toEqual({ id: 'a', version: 3 });
        } finally {
          await adapter.disconnect();
        }
      });
    }
    it('checks same-row scope before a stale committed read can return a miss', async () => {
      const adapter = backend.make();
      await adapter.connect();
      try {
        const root = adapter.createDataSource('Row');
        await root.create({ id: 'a', version: 1 });
        const tx = await adapter.beginTransaction();
        const source = tx.createDataSource('Row');
        await source.update('a', { version: 2 });
        await root.delete('a');
        await expect(source.updateWhere!('a', { version: 1 }, { version: 3 })).rejects.toThrow(
          /only write|already writes|already contains an operation/,
        );
        await tx.rollback();
        await root.create({ id: 'a', version: 1 });
        const next = await adapter.beginTransaction();
        const conditional = next.createDataSource('Row');
        await conditional.updateWhere!('a', { version: 1 }, { version: 2 });
        await root.delete('a');
        await expect(conditional.update('a', { version: 4 })).rejects.toThrow(
          /only write|already writes|already contains an operation/,
        );
        await next.rollback();
      } finally {
        await adapter.disconnect();
      }
    });
  });

describe('bigtable transactional conditionals agree with the commit predicate', () => {
  const make = (valueEncoding?: 'raw', store = new FakeBigtableStore()): BigtableAdapter =>
    new BigtableAdapter({
      instance: 'i',
      client: createFakeBigtableClient(store),
      tables: { Row: valueEncoding === undefined ? {} : { valueEncoding } },
    });

  it('agrees with the direct path on a cell another writer stored untagged', async () => {
    const store = new FakeBigtableStore();
    store.seed('Row', 'a', { cf: { id: 's:a', status: 'active' } });
    const adapter = make(undefined, store);
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      // The decoder reads the untagged cell back as 'active' ...
      expect(await root.findById('a')).toMatchObject({ status: 'active' });
      // ... but its text is not the tagged 's:active' the predicate compares.
      expect(await root.updateWhere!('a', { status: 'active' }, { note: 'x' })).toBeNull();
      expect(await root.deleteWhere!('a', { status: 'active' })).toBe(false);
      const tx = await adapter.beginTransaction();
      const source = tx.createDataSource('Row');
      expect(await source.updateWhere!('a', { status: 'active' }, { note: 'x' })).toBeNull();
      expect(await source.deleteWhere!('a', { status: 'active' })).toBe(false);
      await tx.commit();
    } finally {
      await adapter.disconnect();
    }
  });

  it('answers a miss at the call for a predicated key field with no stored cell', async () => {
    const store = new FakeBigtableStore();
    // Written by another writer: no cell for the key field, only the row key.
    store.seed('Row', 'a', { cf: { version: 'n:1' } });
    const adapter = make(undefined, store);
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      expect(await root.findById('a')).toMatchObject({ id: 'a', version: 1 });
      expect(await root.updateWhere!('a', { id: 'a' }, { version: 2 })).toBeNull();
      expect(await root.deleteWhere!('a', { id: 'a' })).toBe(false);
      const tx = await adapter.beginTransaction();
      const source = tx.createDataSource('Row');
      expect(await source.updateWhere!('a', { id: 'a' }, { version: 2 })).toBeNull();
      expect(await source.deleteWhere!('a', { id: 'a' })).toBe(false);
      await tx.commit();
      expect(await root.findById('a')).toMatchObject({ version: 1 });
    } finally {
      await adapter.disconnect();
    }
  });

  it('checks at commit that a row a cell-less plain update reported still exists', async () => {
    const adapter = make();
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      await root.create({ id: 'a', name: 'y' });
      const tx = await adapter.beginTransaction();
      expect(await tx.createDataSource('Row').update('a', { note: undefined })).toEqual({
        id: 'a',
        name: 'y',
      });
      await root.delete('a');
      const error: unknown = await tx.commit().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SerializationConflictError);

      await root.create({ id: 'a', name: 'y' });
      const kept = await adapter.beginTransaction();
      await kept.createDataSource('Row').update('a', {});
      await kept.commit();
      expect(await root.findById('a')).toEqual({ id: 'a', name: 'y' });
    } finally {
      await adapter.disconnect();
    }
  });

  it('compares a precondition by its cell text at the call, as the direct path does', async () => {
    for (const valueEncoding of [undefined, 'raw'] as const) {
      const adapter = make(valueEncoding);
      await adapter.connect();
      try {
        const root = adapter.createDataSource('Row');
        await root.create({ id: 'neg', n: -0 });
        await root.create({ id: 'pos', n: 0 });
        // Tagged cells store -0 and 0 as different text; raw cells store 0 for both.
        const tagged = valueEncoding === undefined;
        const direct = {
          update: await root.updateWhere!('neg', { n: 0 }, { name: 'direct' }),
          delete: await root.deleteWhere!('pos', { n: -0 }),
        };
        expect({ update: direct.update !== null, delete: direct.delete }).toEqual({
          update: !tagged,
          delete: !tagged,
        });
        if (!tagged) await root.create({ id: 'pos', n: 0 });
        const tx = await adapter.beginTransaction();
        const update = await tx.createDataSource('Row').updateWhere!('neg', { n: 0 }, { m: 1 });
        expect(update !== null).toBe(!tagged);
        await tx.commit();
        const next = await adapter.beginTransaction();
        expect(await next.createDataSource('Row').deleteWhere!('pos', { n: -0 })).toBe(!tagged);
        await next.commit();
      } finally {
        await adapter.disconnect();
      }
    }
  });

  it('checks the predicate of an update that writes no cell at commit', async () => {
    const adapter = make();
    await adapter.connect();
    try {
      const root = adapter.createDataSource('Row');
      await root.create({ id: 'a', name: 'y' });
      const tx = await adapter.beginTransaction();
      expect(
        await tx.createDataSource('Row').updateWhere!('a', { name: 'y' }, { note: undefined }),
      ).toEqual({ id: 'a', name: 'y' });
      await root.update('a', { name: 'changed' });
      const error: unknown = await tx.commit().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SerializationConflictError);

      const kept = await adapter.beginTransaction();
      expect(
        await kept.createDataSource('Row').updateWhere!(
          'a',
          { name: 'changed' },
          { note: undefined },
        ),
      ).toEqual({ id: 'a', name: 'changed' });
      await kept.commit();
      expect(await root.findById('a')).toEqual({ id: 'a', name: 'changed' });
    } finally {
      await adapter.disconnect();
    }
  });
});

describe('dynamodb transactional conditional pre-reads', () => {
  it('read strongly consistently, since their answer decides whether the write is buffered', async () => {
    const { client } = dynamoFixture();
    const inputs: unknown[] = [];
    const recording = {
      ...client,
      getItem: (
        input: Parameters<typeof client.getItem>[0],
        options?: Parameters<typeof client.getItem>[1],
      ) => {
        inputs.push(input);
        return client.getItem(input, options);
      },
    };
    const adapter = new DynamoAdapter({
      client: recording,
      entities: { Row: { partitionKey: 'id' } },
    });
    await adapter.connect();
    try {
      await adapter.createDataSource('Row').create({ id: 'a', version: 1 });
      for (const write of ['update', 'delete'] as const) {
        inputs.length = 0;
        const tx = await adapter.beginTransaction();
        const source = tx.createDataSource('Row');
        if (write === 'update') await source.updateWhere!('a', { version: 1 }, { version: 2 });
        else await source.deleteWhere!('a', { version: 1 });
        await tx.rollback();
        expect(inputs, write).toEqual([expect.objectContaining({ ConsistentRead: true })]);
      }
    } finally {
      await adapter.disconnect();
    }
  });
});
