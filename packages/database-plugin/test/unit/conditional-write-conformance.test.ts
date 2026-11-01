import { PrimaryKeyChangeError } from '@setu-ts/common';
import { describe, expect, it } from 'vitest';
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
import {
  EntityNotFoundError,
  UnsupportedQueryFeatureError,
  VersionConflictError,
} from '../../src/errors.ts';
import { deleteVersioned, updateVersioned } from '../../src/repositories/versioned-write.ts';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { MongoAdapter } from '../../src/adapters/mongo/mongo-adapter.ts';
import { createDrizzleDatabase } from '../../src/index.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';
import { FakeMongoClient } from '../fixtures/fake-mongo-client.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
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
describe('conditional adapter native error paths', () => {
  it('DynamoDB preserves non-condition errors and refuses missing ALL_NEW attributes', async () => {
    const fixture = dynamoFixture();
    await fixture.source.create({ id: 'a', role: 'owner', name: 'old' });
    await expect(
      fixture.source.updateWhere!('a', { role: 'owner' }, { id: 'b' }),
    ).rejects.toBeInstanceOf(PrimaryKeyChangeError);
    expect(fixture.calls).toEqual([]);
    const error = new Error('driver fault');
    fixture.fail(error);
    await expect(fixture.source.updateWhere!('a', { role: 'owner' }, { name: 'new' })).rejects.toBe(
      error,
    );
    await expect(fixture.source.deleteWhere!('a', { role: 'owner' })).rejects.toBe(error);
    const missing = dynamoFixture();
    await missing.source.create({ id: 'a', role: 'owner' });
    missing.omitAttributes();
    await expect(
      missing.source.updateWhere!('a', { role: 'owner' }, { name: 'new' }),
    ).rejects.toThrow(/returned no row/);
  });
  it('MongoDB key-only payload still checks the conjoined predicate', async () => {
    const source = sources.find((entry) => entry.name === 'mongodb')!.make();
    await source.create({ id: 'a', role: 'owner' });
    await expect(
      source.updateWhere!('a', { role: 'owner' }, { id: 'ignored' }),
    ).rejects.toBeInstanceOf(PrimaryKeyChangeError);
    expect(await source.updateWhere!('a', { role: 'owner' }, { id: 'a' })).toMatchObject({
      id: 'a',
    });
    expect(await source.updateWhere!('a', { role: 'other' }, { id: 'a' })).toBeNull();
    expect(await source.findById('ignored')).toBeNull();
  });
  it('memory validates before mutation and preserves key immutability', async () => {
    const source = new MemoryAdapter().createDataSource('User');
    await source.create({ id: 'a', role: 'owner' });
    await expect(source.updateWhere!('a', { role: 'owner' }, { id: 'b' })).rejects.toThrow(/key/);
    expect(await source.findById('a')).toMatchObject({ id: 'a' });
    expect(await source.findById('b')).toBeNull();
  });
});
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
      { entity: 'users', table: 'users', primaryKey: ['id'] },
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
      for (const [id, where] of [
        ['a', { role: 'other' }],
        ['missing', { role: 'owner' }],
        [
          'a',
          {
            id: 'b',
          },
        ],
      ] as const) {
        expect(await ds.updateWhere!(id, where, { name: 'bad' })).toBeNull();
        expect(await ds.deleteWhere!(id, where)).toBe(false);
      }
      expect(await ds.findById('a')).toMatchObject({ name: 'old' });
      expect(await ds.findById('b')).toMatchObject({ name: 'untouched' });
      expect(
        await ds.updateWhere!('a', { role: 'owner', name: 'old' }, { name: 'new' }),
      ).toMatchObject({ id: 'a', name: 'new' });
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
        { n: Number.NaN },
        { n: Number.POSITIVE_INFINITY },
        JSON.parse('{"__proto__":"x"}'),
        JSON.parse('{"__proto__":"x","role":"owner"}'),
      ];
      for (const value of refused) {
        const where = value as WritePrecondition;
        await expect(ds.updateWhere!('a', where, { name: 'bad' })).rejects.toThrow();
        await expect(ds.deleteWhere!('a', where)).rejects.toThrow();
      }
      await expect(ds.updateWhere!('a', { role: 'owner' }, {})).rejects.toThrow();
      await expect(
        ds.updateWhere!('a', { role: 'owner' }, JSON.parse('{"__proto__":{"isAdmin":true}}')),
      ).rejects.toThrow(/__proto__/);
      expect(await ds.findById('a')).toBeNull();
    });
    // `constructor` and `toString` are inherited members of a plain object: a
    // field map read without an own-property check would resolve them.
    for (const field of ['canary_field', 'constructor', 'toString']) {
      it(`${name}: unknown column '${field}' is ${unknown} and never echoed`, async () => {
        const source = make();
        const ds =
          name === 'prisma'
            ? new DatabaseService(new MemoryAdapter(), () => source, 'prisma').getRepository('User')
            : source;
        await ds.create({ id: 'a', role: 'owner', name: 'old' });
        const where = { [field]: 'canary-value' };
        if (unknown === 'throws') {
          for (const attempt of [
            () => ds.updateWhere!('a', where, { name: 'canary-payload' }),
            () => ds.deleteWhere!('a', where),
          ]) {
            const error = await attempt().then(
              () => undefined,
              (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(Error);
            const message = (error as Error).message;
            expect(message).not.toContain('canary-value');
            expect(message).not.toContain('canary-payload');
            // D1's unknown-column refusal is SQLite's own driver diagnostic,
            // which names the column (as for every D1 statement).
            if (name !== 'd1' && name !== 'prisma') expect(message).not.toContain(field);
          }
        } else {
          expect(await ds.updateWhere!('a', where, { name: 'bad' })).toBeNull();
          expect(await ds.deleteWhere!('a', where)).toBe(false);
        }
        expect(await ds.findById('a')).toMatchObject({ name: 'old' });
      });
    }
    it(`${name}: writes the validated copy of a key-swapping predicate`, async () => {
      const ds = make();
      await ds.create({ id: 'a', role: 'owner', name: 'old' });
      await ds.create({ id: 'b', role: 'other', name: 'untouched' });
      let reads = 0;
      // Legitimate on the first read of each field; an operator afterwards.
      const swapping = () =>
        new Proxy({ role: 'other' } as Record<string, unknown>, {
          get(target, key) {
            reads += 1;
            return reads === 1 ? Reflect.get(target, key) : { $ne: 'nothing' };
          },
        }) as WritePrecondition;
      reads = 0;
      expect(await ds.updateWhere!('a', swapping(), { name: 'bad' })).toBeNull();
      reads = 0;
      expect(await ds.deleteWhere!('a', swapping())).toBe(false);
      expect(await ds.findById('a')).toMatchObject({ name: 'old' });
      expect(await ds.findById('b')).toMatchObject({ name: 'untouched' });
    });
  }
});

describe('updateVersioned / deleteVersioned at every public data source (M128)', () => {
  for (const { name, make } of sources) {
    it(`${name}: applied, stale and missing`, async () => {
      const repo = new Repo(make());
      await repo.create({ id: 'a', name: 'old', version: 1 });
      const updated = await updateVersioned(repo, 'a', 1, { name: 'new' }, { entity: 'User' });
      expect(updated).toMatchObject({ id: 'a', name: 'new', version: 2 });
      const stale = await updateVersioned(repo, 'a', 1, { name: 'lost' }).catch((e: unknown) => e);
      expect(stale).toBeInstanceOf(VersionConflictError);
      expect(await repo.findById('a')).toMatchObject({ name: 'new', version: 2 });
      await expect(updateVersioned(repo, 'missing', 1, { name: 'x' })).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
      await expect(deleteVersioned(repo, 'a', 1)).rejects.toBeInstanceOf(VersionConflictError);
      await deleteVersioned(repo, 'a', 2);
      expect(await repo.findById('a')).toBeNull();
      await expect(deleteVersioned(repo, 'a', 2)).rejects.toBeInstanceOf(EntityNotFoundError);
    });
  }
});

/**
 * Inside a transaction, the versioned write applies exactly where the
 * transaction-scoped source has conditional writes. The two sets are data:
 * a source moving between them fails here, not in prose.
 */
const TRANSACTION_OUTCOMES: Readonly<Record<'applies' | 'refuses', readonly string[]>> = {
  applies: ['drizzle', 'prisma', 'mongodb'],
  refuses: ['memory', 'd1', 'dynamodb', 'cosmos', 'bigtable'],
};

describe('updateVersioned inside a transaction (M128)', () => {
  it('the two sets cover every adapter exactly once', () => {
    expect([...TRANSACTION_OUTCOMES.applies, ...TRANSACTION_OUTCOMES.refuses].sort()).toEqual(
      sources.map((source) => source.name).sort(),
    );
  });

  it('applies on the transaction sources with conditional writes', async () => {
    const transactionSources = await applyingTransactionSources();
    expect(Object.keys(transactionSources).sort()).toEqual(
      [...TRANSACTION_OUTCOMES.applies].sort(),
    );
    for (const [name, { source, done }] of Object.entries(transactionSources)) {
      try {
        const repo = new Repo(source);
        await repo.create({ id: 'a', name: 'old', version: 1 });
        await expect(updateVersioned(repo, 'a', 1, { name: 'new' }), name).resolves.toMatchObject({
          version: 2,
        });
        await expect(updateVersioned(repo, 'a', 1, { name: 'x' }), name).rejects.toBeInstanceOf(
          VersionConflictError,
        );
      } finally {
        await done();
      }
    }
  });

  it('refuses on the buffered and deferred transaction sources with conditional-write', async () => {
    const transactionSources = await refusingTransactionSources();
    expect(Object.keys(transactionSources).sort()).toEqual(
      [...TRANSACTION_OUTCOMES.refuses].sort(),
    );
    for (const [name, { source, done }] of Object.entries(transactionSources)) {
      try {
        const repo = new Repo(source);
        await expect(updateVersioned(repo, 'a', 1, { name: 'x' }), name).rejects.toMatchObject({
          feature: 'conditional-write',
        });
        await expect(deleteVersioned(repo, 'a', 1), name).rejects.toMatchObject({
          feature: 'conditional-write',
        });
      } finally {
        await done();
      }
    }
  });
});

/** One transaction-scoped source per applying adapter, opened through the adapter itself. */
async function applyingTransactionSources(): Promise<
  Record<string, { source: import('@setu-ts/common').IDataSource; done: () => Promise<void> }>
> {
  const prismaClient = createFakePrismaClient();
  const adapters = {
    drizzle: new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(createFakeDrizzleInstance(), (database, work) =>
        database.transaction(work),
      ),
      drizzleTables: { User: createFakeDrizzleTable('user') },
    }),
    prisma: new PrismaAdapter({ prismaClient }),
    mongodb: new MongoAdapter({
      url: 'mongodb://localhost:27017/db',
      client: new FakeMongoClient(),
    }),
  };
  const result: Record<
    string,
    { source: import('@setu-ts/common').IDataSource; done: () => Promise<void> }
  > = {};
  for (const [name, adapter] of Object.entries(adapters)) {
    await adapter.connect();
    const tx = await adapter.beginTransaction();
    result[name] = {
      source: tx.createDataSource('User'),
      done: async () => {
        await tx.rollback();
        await adapter.disconnect();
      },
    };
  }
  return result;
}

/** One transaction-scoped source per refusing adapter, each with its teardown. */
async function refusingTransactionSources(): Promise<
  Record<string, { source: import('@setu-ts/common').IDataSource; done: () => Promise<void> }>
> {
  const result: Record<
    string,
    { source: import('@setu-ts/common').IDataSource; done: () => Promise<void> }
  > = {};
  const adapters = {
    memory: new MemoryAdapter(),
    dynamodb: new DynamoAdapter({
      client: dynamoFixture().client,
      entities: { User: { partitionKey: 'id' } },
    }),
    cosmos: new CosmosAdapter({
      database: 'db',
      client: createFakeCosmosClient({ containers: { User: { partitionKeyPaths: ['/id'] } } })
        .client,
    }),
    bigtable: new BigtableAdapter({
      client: createFakeBigtableClient(new FakeBigtableStore()),
      instance: 'i',
    }),
  };
  for (const [name, adapter] of Object.entries(adapters)) {
    await adapter.connect();
    const tx = await adapter.beginTransaction();
    result[name] = {
      source: tx.createDataSource('User'),
      done: async () => {
        await tx.rollback();
        await adapter.disconnect();
      },
    };
  }
  result['d1'] = {
    source: createD1TransactionDataSource(
      new SqliteD1('CREATE TABLE users(id TEXT PRIMARY KEY)'),
      { entity: 'users', table: 'users', primaryKey: ['id'] },
      new D1TransactionBuffer(),
    ),
    done: () => Promise.resolve(),
  };
  return result;
}
