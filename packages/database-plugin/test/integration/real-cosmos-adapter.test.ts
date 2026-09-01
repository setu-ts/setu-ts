/**
 * Real-emulator exercise for the Cosmos adapter.
 *
 * Guarded on `COSMOS_ENDPOINT` and declared with the BDD `ignore` option rather
 * than an early `return`, so an unset variable is reported as **ignored**
 * instead of as a passing test that exercised nothing (the M70c trap, in test
 * form).
 *
 * This is the only place the milestone's measured facts are proven against the
 * service rather than against a double: the lazy `npm:@azure/cosmos` import,
 * partition-key discovery from a real container definition, a point read whose
 * wrong partition key answers 404 rather than an error, the keyset page walk
 * over deliberately TIED sort values, the patch and replace update paths, and a
 * real transactional batch with a real rollback.
 *
 * Run it against the local emulator with:
 *
 * ```
 * COSMOS_ENDPOINT=http://127.0.0.1:8082/ COSMOS_KEY=<emulator key> \
 *   deno test -A packages/database-plugin/test/integration/real-cosmos-adapter.test.ts
 * ```
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';
import { CosmosAdapter } from '../../src/adapters/cosmos/cosmos-adapter.ts';
import type {
  ICosmosClient,
  ICosmosContainer,
} from '../../src/adapters/cosmos/cosmos-client-types.ts';

/** The account endpoint; absent, every case below is ignored. */
const endpoint = Deno.env.get('COSMOS_ENDPOINT');
/** The well-known emulator key, overridable for a real account. */
const key = Deno.env.get('COSMOS_KEY') ??
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';
const skipReal = endpoint === undefined;
/** The database every case shares; created once by the setup helper. */
const databaseId = 'setu_m81';

/**
 * Builds a fully-resolved query, so each case states only what it varies.
 *
 * @param partial - The members to override
 * @returns The normalized query
 */
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

/** A per-run discriminator keeping this run's containers from any other's. */
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);

/**
 * Creates the database and one container with the named partition-key path,
 * through the real SDK — the adapter deliberately provisions nothing.
 *
 * @param containerId - The container to create
 * @param partitionKeyPath - Its partition-key path, leading slash included
 * @returns The created container's id
 */
async function provision(containerId: string, partitionKeyPath: string): Promise<string> {
  const { CosmosClient } = await import('npm:@azure/cosmos@^4');
  const client = new CosmosClient({ endpoint: endpoint as string, key });
  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  await database.containers.createIfNotExists({
    id: containerId,
    partitionKey: { paths: [partitionKeyPath] },
  });
  return containerId;
}

describe('CosmosAdapter against a real Cosmos emulator (guarded)', () => {
  it('lazily imports the SDK and reads CRUD operations back through IDataSource', {
    ignore: skipReal,
  }, async () => {
    const container = await provision(`orders_${suffix}`, '/tenantId');
    const adapter = new CosmosAdapter({
      endpoint: endpoint as string,
      key,
      database: databaseId,
      containers: { Order: { container, partitionKey: 'tenantId' } },
    });
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    try {
      const orders = adapter.createDataSource('Order');

      const created = await orders.create({ id: 'o1', tenantId: 't1', total: 10 });
      // System properties never leave the adapter.
      expect(Object.keys(created).sort()).toEqual(['id', 'tenantId', 'total']);

      // The composite key carries the partition key, so this is a point read.
      const read = await orders.findById({ id: 'o1', tenantId: 't1' });
      expect(read).toEqual({ id: 'o1', tenantId: 't1', total: 10 });

      // A wrong partition key answers 404 through the SDK, which the adapter
      // reports as "no such row" rather than as an error.
      expect(await orders.findById({ id: 'o1', tenantId: 'nope' })).toBeNull();

      // A scalar key with a distinct partition-key field falls back to a
      // cross-partition query, which finds the row.
      expect(await orders.findById('o1')).toEqual({ id: 'o1', tenantId: 't1', total: 10 });

      const updated = await orders.update({ id: 'o1', tenantId: 't1' }, { total: 99 });
      expect(updated['total']).toBe(99);
      expect((await orders.findById('o1'))?.['total']).toBe(99);

      await orders.create({ id: 'o2', tenantId: 't1', total: 5 });
      expect(await orders.count({})).toBe(2);
      expect(await orders.count({ tenantId: 't1' })).toBe(2);

      const found = await orders.findAll(query({ orderBy: { total: 'asc' }, select: ['id'] }));
      expect(found).toEqual([{ id: 'o2' }, { id: 'o1' }]);

      expect(await orders.delete({ id: 'o2', tenantId: 't1' })).toBe(true);
      expect(await orders.delete({ id: 'o2', tenantId: 't1' })).toBe(false);
    } finally {
      await adapter.disconnect();
    }
  });

  it('refuses a mapping whose partition key disagrees with the container', {
    ignore: skipReal,
  }, async () => {
    const container = await provision(`mismatch_${suffix}`, '/tenantId');
    const adapter = new CosmosAdapter({
      endpoint: endpoint as string,
      key,
      database: databaseId,
      containers: { Order: { container, partitionKey: 'accountId' } },
    });
    await adapter.connect();
    try {
      await expect(adapter.createDataSource('Order').findById({ id: 'x', accountId: 'a' }))
        .rejects.toThrow(/partition-key mismatch/);
    } finally {
      await adapter.disconnect();
    }
  });

  it('names a container that does not exist rather than failing on the first read', {
    ignore: skipReal,
  }, async () => {
    const adapter = new CosmosAdapter({
      endpoint: endpoint as string,
      key,
      database: databaseId,
      containers: { Ghost: { container: `absent_${suffix}` } },
    });
    await adapter.connect();
    try {
      await expect(adapter.createDataSource('Ghost').findById('x'))
        .rejects.toThrow(/could not read container/);
    } finally {
      await adapter.disconnect();
    }
  });

  it('walks a keyset page over TIED sort values without skipping or repeating', {
    ignore: skipReal,
  }, async () => {
    const container = await provision(`paged_${suffix}`, '/tenantId');
    const adapter = new CosmosAdapter({
      endpoint: endpoint as string,
      key,
      database: databaseId,
      containers: { Page: { container, partitionKey: 'tenantId' } },
    });
    await adapter.connect();
    try {
      const pages = adapter.createDataSource('Page');
      // Six rows over TWO distinct sort values: without the key tiebreaker a
      // keyset walk silently returns four of six (M79's measured control).
      for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
        await pages.create({ id, tenantId: 't1', rank: id <= 'p3' ? 1 : 2 });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const result = await pages.findPage?.(
          query({
            orderBy: { rank: 'asc' },
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        expect(result).toBeDefined();
        for (const row of result?.rows ?? []) seen.push(row['id'] as string);
        if (result?.nextCursor == null) break;
        cursor = result.nextCursor;
      }
      expect(seen.sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    } finally {
      await adapter.disconnect();
    }
  });

  it('serves a wide update through the replace path and a narrow one through patch', {
    ignore: skipReal,
  }, async () => {
    const container = await provision(`wide_${suffix}`, '/tenantId');
    const adapter = new CosmosAdapter({
      endpoint: endpoint as string,
      key,
      database: databaseId,
      containers: { Wide: { container, partitionKey: 'tenantId' } },
    });
    await adapter.connect();
    try {
      const wide = adapter.createDataSource('Wide');
      await wide.create({ id: 'w1', tenantId: 't1', keep: 'yes' });
      // Twelve fields exceeds the per-request patch limit, so this takes the
      // read-merge-replace path with its `IfMatch` guard.
      const payload: Record<string, unknown> = {};
      for (let i = 0; i < 12; i++) payload[`f${i}`] = i;
      const replaced = await wide.update({ id: 'w1', tenantId: 't1' }, payload);
      expect(replaced['f11']).toBe(11);
      expect(replaced['keep']).toBe('yes');

      const patched = await wide.update({ id: 'w1', tenantId: 't1' }, { f0: 100 });
      expect(patched['f0']).toBe(100);
      expect(patched['f11']).toBe(11);

      // A payload that would move the row to another partition is refused
      // rather than answered with the service's own bare 404.
      await expect(wide.update({ id: 'w1', tenantId: 't1' }, { tenantId: 't2' }))
        .rejects.toThrow(/change the partition key/);
    } finally {
      await adapter.disconnect();
    }
  });

  it('commits a transactional batch atomically and sends nothing on rollback', {
    ignore: skipReal,
  }, async () => {
    const container = await provision(`tx_${suffix}`, '/tenantId');
    const adapter = new CosmosAdapter({
      endpoint: endpoint as string,
      key,
      database: databaseId,
      containers: { Tx: { container, partitionKey: 'tenantId' } },
    });
    await adapter.connect();
    try {
      const committed = await adapter.beginTransaction();
      const source = committed.createDataSource('Tx');
      await source.create({ id: 'c1', tenantId: 't1' });
      await source.create({ id: 'c2', tenantId: 't1' });
      await committed.commit();

      const outside = adapter.createDataSource('Tx');
      expect(await outside.findById({ id: 'c1', tenantId: 't1' })).not.toBeNull();
      expect(await outside.findById({ id: 'c2', tenantId: 't1' })).not.toBeNull();

      const rolled = await adapter.beginTransaction();
      await rolled.createDataSource('Tx').create({ id: 'r1', tenantId: 't1' });
      await rolled.rollback();
      expect(await outside.findById({ id: 'r1', tenantId: 't1' })).toBeNull();

      // A second partition-key value cannot ride the same batch.
      const scoped = await adapter.beginTransaction();
      const scopedSource = scoped.createDataSource('Tx');
      await scopedSource.create({ id: 's1', tenantId: 't1' });
      await expect(scopedSource.create({ id: 's2', tenantId: 't2' }))
        .rejects.toThrow(/single\s+partition-key value/);
      await scoped.rollback();
    } finally {
      await adapter.disconnect();
    }
  });

  it('accepts an injected client, so the lazy import never runs', {
    ignore: skipReal,
  }, async () => {
    const container = await provision(`injected_${suffix}`, '/tenantId');
    const { CosmosClient } = await import('npm:@azure/cosmos@^4');
    const real = new CosmosClient({ endpoint: endpoint as string, key });
    let containerReads = 0;
    // A thin recording wrapper over the real client, so the injected branch is
    // proven to be the one that ran.
    const client: ICosmosClient = {
      database: (id) => {
        const db = real.database(id);
        return {
          read: () => db.read() as unknown as ReturnType<ICosmosDatabaseRead>,
          container: (containerId) => {
            containerReads++;
            return db.container(containerId) as unknown as ICosmosContainer;
          },
        };
      },
    };
    const adapter = new CosmosAdapter({
      client,
      database: databaseId,
      containers: { Inj: { container } },
    });
    await adapter.connect();
    try {
      const rows = adapter.createDataSource('Inj');
      await rows.create({ id: 'i1', tenantId: 't1' });
      expect(await rows.findById('i1')).not.toBeNull();
      expect(containerReads).toBeGreaterThan(0);
    } finally {
      await adapter.disconnect();
    }
  });
});

/** The shape of the database `read()` the recording wrapper delegates. */
type ICosmosDatabaseRead = () => Promise<{ statusCode: number }>;
