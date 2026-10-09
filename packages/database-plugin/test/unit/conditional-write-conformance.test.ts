import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { WritePrecondition } from '@setu-ts/common';
import { sources } from '../fixtures/conditional-sources.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { CosmosAdapter } from '../../src/adapters/cosmos/cosmos-adapter.ts';
import { BigtableAdapter } from '../../src/adapters/bigtable/bigtable-adapter.ts';
import { DynamoAdapter } from '../../src/adapters/dynamo/dynamo-adapter.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';
import { dynamoFixture } from '../fixtures/conditional-dynamo.ts';
import { BaseRepository } from '../../src/repositories/base-repository.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import {
  createD1TransactionDataSource,
  D1TransactionBuffer,
} from '../../../cloudflare-plugin/src/database/d1-data-source.ts';
import { SqliteD1 } from '../../../cloudflare-plugin/test/d1-fakes.ts';

class Repo extends BaseRepository<Record<string, unknown>> {
  constructor(source: import('@setu-ts/common').IDataSource) {
    super(source);
  }
}
describe('deferred transaction refuses conditional writes', () => {
  const adapters = [
    { name: 'memory', make: () => new MemoryAdapter() },
    {
      name: 'dynamodb',
      make: () =>
        new DynamoAdapter({
          client: dynamoFixture().client,
          entities: { User: { partitionKey: 'id' } },
        }),
    },
    {
      name: 'cosmos',
      make: () =>
        new CosmosAdapter({
          database: 'db',
          client:
            createFakeCosmosClient({ containers: { User: { partitionKeyPaths: ['/id'] } } }).client,
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
  ];
  for (const { name, make } of adapters) {
    it(name, async () => {
      const adapter = make();
      await adapter.connect();
      const tx = await adapter.beginTransaction();
      try {
        const source = tx.createDataSource('User');
        expect(source.updateWhere).toBeUndefined();
        expect(source.deleteWhere).toBeUndefined();
        const repo = new Repo(source);
        await expect(repo.updateWhere('a', { n: 1 }, { n: 2 })).rejects.toBeInstanceOf(
          UnsupportedQueryFeatureError,
        );
        await expect(repo.deleteWhere('a', { n: 1 })).rejects.toMatchObject({
          feature: 'conditional-write',
        });
      } finally {
        await tx.rollback();
        await adapter.disconnect();
      }
    });
  }
  it('d1', async () => {
    const source = createD1TransactionDataSource(
      new SqliteD1('CREATE TABLE users(id TEXT PRIMARY KEY)'),
      { table: 'users', primaryKey: ['id'] },
      new D1TransactionBuffer(),
    );
    expect(source.updateWhere).toBeUndefined();
    expect(source.deleteWhere).toBeUndefined();
    await expect(new Repo(source).deleteWhere('a', { n: 1 })).rejects.toMatchObject({
      feature: 'conditional-write',
    });
  });
});

describe('conditional writes conjoin key and predicate at every public data source', () => {
  for (const { name, make, unknown } of sources) {
    it(`${name}: matched, mismatched, missing and key-override rows`, async () => {
      const ds = make();
      await ds.create({ id: 'a', role: 'owner', name: 'old' });
      await ds.create({ id: 'b', role: 'other', name: 'untouched' });
      for (
        const [id, where] of [['a', { role: 'other' }], ['missing', { role: 'owner' }], ['a', {
          id: 'b',
        }]] as const
      ) {
        expect(await ds.updateWhere!(id, where, { name: 'bad' })).toBeNull();
        expect(await ds.deleteWhere!(id, where)).toBe(false);
      }
      expect(await ds.findById('a')).toMatchObject({ name: 'old' });
      expect(await ds.findById('b')).toMatchObject({ name: 'untouched' });
      expect(await ds.updateWhere!('a', { role: 'owner', name: 'old' }, { name: 'new' }))
        .toMatchObject({ id: 'a', name: 'new' });
      expect(await ds.findById('a')).toMatchObject({ name: 'new' });
      expect(await ds.deleteWhere!('a', { role: 'owner', name: 'new' })).toBe(true);
      expect(await ds.findById('a')).toBeNull();
    });
    it(`${name}: rejects the refused-input table directly, bypassing BaseRepository`, async () => {
      const ds = make();
      const refused = [
        {},
        null,
        false,
        [],
        new Date(0),
        Object.create({ n: 1 }),
        { n: null },
        { n: false },
        { n: {} },
        { n: [] },
        { n: new Date(0) },
        { $where: 'canary' },
        { 'a.b': 1 },
        { '': 1 },
      ];
      for (const value of refused) {
        const where = value as WritePrecondition;
        await expect(ds.updateWhere!('a', where, { name: 'bad' })).rejects.toThrow();
        await expect(ds.deleteWhere!('a', where)).rejects.toThrow();
      }
      await expect(ds.updateWhere!('a', { role: 'owner' }, {})).rejects.toThrow();
      expect(await ds.findById('a')).toBeNull();
    });
    it(`${name}: unknown-column outcome is ${unknown}`, async () => {
      const ds = make();
      await ds.create({ id: 'a', role: 'owner', name: 'old' });
      if (unknown === 'throws') {
        await expect(ds.updateWhere!('a', { unknown: 1 }, { name: 'bad' })).rejects.toThrow();
        await expect(ds.deleteWhere!('a', { unknown: 1 })).rejects.toThrow();
      } else {
        expect(await ds.updateWhere!('a', { unknown: 1 }, { name: 'bad' })).toBeNull();
        expect(await ds.deleteWhere!('a', { unknown: 1 })).toBe(false);
      }
      expect(await ds.findById('a')).toMatchObject({ name: 'old' });
    });
  }
});
