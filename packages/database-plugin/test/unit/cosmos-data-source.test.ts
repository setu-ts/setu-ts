/**
 * Unit tests for the Cosmos data source: the six `IDataSource` members, the
 * three `findById` address cases, and the refusals.
 *
 * The fake reproduces the SDK's MEASURED asymmetry — a missing point read
 * RETURNS a 404 envelope while a missing delete THROWS — so a data source that
 * confused the two would fail here.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';
import {
  conjoinFilters,
  createCosmosDataSource,
  missingRow,
  partitionsByPrimaryKey,
  statusOf,
} from '../../src/adapters/cosmos/cosmos-data-source.ts';
import { resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { PartitionKeyResolver } from '../../src/adapters/cosmos/cosmos-partition-key.ts';
import {
  createFakeCosmosClient,
  FakeCosmosError,
  type FakeCosmosOptions,
} from '../fixtures/fake-cosmos-client.ts';

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

/**
 * Builds a data source over a fake client.
 *
 * @param options - The fake's containers and scripted query results
 * @param mapping - The per-entity mapping for the `Order` entity
 * @returns The data source plus the fake, for assertions
 */
function makeSource(
  options: FakeCosmosOptions,
  mapping?: Parameters<typeof resolveCosmosTarget>[1],
) {
  const fake = createFakeCosmosClient(options);
  const database = fake.client.database('db');
  const source = createCosmosDataSource({
    database,
    target: resolveCosmosTarget('Order', mapping),
    partitionKeys: new PartitionKeyResolver(database),
  });
  return { fake, source };
}

const withTenant = { Order: { container: 'Order', partitionKey: 'tenantId' } };

describe('findAll', () => {
  it('maps every returned document out of the driver shape', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
      queryResults: [[{ id: 'o1', total: 1, _etag: 'e', _ts: 2 }]],
    }, withTenant);
    expect(await source.findAll(query())).toEqual([{ id: 'o1', total: 1 }]);
  });
});

describe('findById', () => {
  it('point-reads when the composite key carries the partition key', async () => {
    const { source, fake } = makeSource({
      containers: {
        Order: {
          partitionKeyPaths: ['/tenantId'],
          documents: { 't1|o1': { id: 'o1', tenantId: 't1', total: 4 } },
        },
      },
    }, withTenant);
    expect(await source.findById({ id: 'o1', tenantId: 't1' }))
      .toEqual({ id: 'o1', tenantId: 't1', total: 4 });
    // A point read issues no query at all.
    expect(fake.recorder.queries).toEqual([]);
  });

  it('reports null for a point read that answers 404', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
    }, withTenant);
    expect(await source.findById({ id: 'missing', tenantId: 't1' })).toBeNull();
  });

  it('point-reads a scalar key when the container partitions BY the primary key', async () => {
    const { source, fake } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/id'], documents: { 'o1|o1': { id: 'o1' } } } },
    });
    expect(await source.findById('o1')).toEqual({ id: 'o1' });
    expect(fake.recorder.queries).toEqual([]);
  });

  it('falls back to a cross-partition query for a scalar key on another partition field', async () => {
    const { source, fake } = makeSource({
      containers: {
        Order: {
          partitionKeyPaths: ['/tenantId'],
          documents: { 't1|o1': { id: 'o1', tenantId: 't1' } },
        },
      },
      queryResults: [[{ id: 'o1', tenantId: 't1' }]],
    }, withTenant);
    expect(await source.findById('o1')).toEqual({ id: 'o1', tenantId: 't1' });
    expect(fake.recorder.queries[0]?.query).toContain('LIMIT 2');
  });

  it('reports null when the cross-partition lookup finds nothing', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
      queryResults: [[]],
    }, withTenant);
    expect(await source.findById('nope')).toBeNull();
  });

  it('refuses an id that matches two documents rather than picking one', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
      queryResults: [[{ id: 'dup', tenantId: 'a' }, { id: 'dup', tenantId: 'b' }]],
    }, withTenant);
    await expect(source.findById('dup'))
      .rejects.toThrow(
        /matches more than one document.*composite key carrying 'id' and \/tenantId/s,
      );
  });

  it('refuses a composite key missing the primary-key column', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
    }, withTenant);
    await expect(source.findById({ tenantId: 't1' })).rejects.toThrow(/must carry 'id'/);
  });

  it('refuses a composite key missing the partition-key column', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
    }, withTenant);
    await expect(source.findById({ id: 'o1', other: 'x' }))
      .rejects.toThrow(/must carry the partition key \/tenantId/);
  });

  it('refuses a non-string id, naming the service rule', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/id'] } },
    });
    await expect(source.findById(7)).rejects.toThrow(/document id must be a string/);
  });

  it('reads a hierarchical partition key as an ordered array', async () => {
    const { source } = makeSource({
      containers: {
        Order: {
          partitionKeyPaths: ['/tenantId', '/region'],
          documents: { '["t1","in"]|o1': { id: 'o1', tenantId: 't1', region: 'in' } },
        },
      },
    }, { Order: { partitionKey: [['tenantId'], ['region']] } });
    expect(await source.findById({ id: 'o1', tenantId: 't1', region: 'in' }))
      .toEqual({ id: 'o1', tenantId: 't1', region: 'in' });
  });

  it('reads a nested partition key from a composite key by its dotted join', async () => {
    const { source } = makeSource({
      containers: {
        Order: {
          partitionKeyPaths: ['/address/city'],
          documents: { 'Kolkata|o1': { id: 'o1' } },
        },
      },
    }, { Order: { partitionKey: ['address', 'city'] } });
    expect(await source.findById({ id: 'o1', 'address.city': 'Kolkata' })).toEqual({ id: 'o1' });
  });
});

describe('create', () => {
  it('inserts the document and returns the persisted row', async () => {
    const { source, fake } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
    }, withTenant);
    expect(await source.create({ id: 'o1', tenantId: 't1' }))
      .toEqual({ id: 'o1', tenantId: 't1' });
    expect(fake.documents.size).toBe(1);
  });

  it('renames the mapped primary key onto the document id', async () => {
    const { source, fake } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/id'] } },
    }, { Order: { primaryKey: 'orderId' } });
    expect(await source.create({ orderId: 'o1' })).toEqual({ orderId: 'o1' });
    expect([...fake.documents.values()][0]?.['id']).toBe('o1');
  });

  it('refuses a non-string id before the request is made', async () => {
    const { source, fake } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/id'] } },
    });
    await expect(source.create({ id: 5 })).rejects.toThrow(/must be a string/);
    expect(fake.documents.size).toBe(0);
  });

  it('returns the row it wrote when the service answers with no resource', async () => {
    const fake = createFakeCosmosClient({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
    });
    const database = fake.client.database('db');
    const bare = {
      read: database.read.bind(database),
      container: (id: string) => {
        const container = database.container(id);
        return {
          ...container,
          items: { ...container.items, create: () => Promise.resolve({ statusCode: 201 }) },
        };
      },
    };
    const source = createCosmosDataSource({
      database: bare,
      target: resolveCosmosTarget('Order', withTenant),
      partitionKeys: new PartitionKeyResolver(bare),
    });
    expect(await source.create({ id: 'o1', tenantId: 't1' })).toEqual({ id: 'o1', tenantId: 't1' });
  });

  it('lets a duplicate id surface as the service 409', async () => {
    const { source } = makeSource({
      containers: {
        Order: { partitionKeyPaths: ['/tenantId'], documents: { 't1|o1': { id: 'o1' } } },
      },
    }, withTenant);
    await expect(source.create({ id: 'o1', tenantId: 't1' })).rejects.toThrow(/already exists/);
  });
});

describe('delete', () => {
  it('reports true for a deleted row and false for a missing one', async () => {
    const { source } = makeSource({
      containers: {
        Order: {
          partitionKeyPaths: ['/tenantId'],
          documents: { 't1|o1': { id: 'o1', tenantId: 't1' } },
        },
      },
    }, withTenant);
    expect(await source.delete({ id: 'o1', tenantId: 't1' })).toBe(true);
    expect(await source.delete({ id: 'o1', tenantId: 't1' })).toBe(false);
  });

  it('reports false when the cross-partition lookup finds no row to address', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
      queryResults: [[]],
    }, withTenant);
    expect(await source.delete('gone')).toBe(false);
  });
});

describe('count', () => {
  it('reads the single aggregate row the service returns', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
      queryResults: [[7 as unknown as Record<string, unknown>]],
    }, withTenant);
    expect(await source.count({})).toBe(7);
  });

  it('reports zero when the aggregate row is missing', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
      queryResults: [[]],
    }, withTenant);
    expect(await source.count({})).toBe(0);
  });
});

describe('error propagation', () => {
  /**
   * Wraps a fake container so ONE member fails with a chosen status, leaving
   * every other behaviour faithful.
   *
   * @param member - The item member to break
   * @param code - The status the SDK error carries
   * @returns A data source over the wrapped client
   */
  function withFailingMember(member: 'delete' | 'patch' | 'replace' | 'read', code: number) {
    const fake = createFakeCosmosClient({
      containers: {
        Order: {
          partitionKeyPaths: ['/tenantId'],
          documents: { 't1|o1': { id: 'o1', tenantId: 't1', total: 1 } },
        },
      },
    });
    const database = fake.client.database('db');
    const wrapped = {
      read: database.read.bind(database),
      container: (id: string) => {
        const container = database.container(id);
        return {
          items: container.items,
          read: container.read.bind(container),
          item: (itemId: string, partitionKey?: Parameters<typeof container.item>[1]) => {
            const item = container.item(itemId, partitionKey);
            return {
              ...item,
              [member]: () => Promise.reject(new FakeCosmosError(code, `boom ${code}`)),
            };
          },
        };
      },
    };
    return createCosmosDataSource({
      database: wrapped,
      target: resolveCosmosTarget('Order', withTenant),
      partitionKeys: new PartitionKeyResolver(wrapped),
    });
  }

  it('propagates a non-404 failure from delete rather than reporting "not found"', async () => {
    await expect(withFailingMember('delete', 503).delete({ id: 'o1', tenantId: 't1' }))
      .rejects.toThrow(/boom 503/);
  });

  it('propagates a non-404 failure from a patch update', async () => {
    await expect(withFailingMember('patch', 429).update({ id: 'o1', tenantId: 't1' }, { total: 2 }))
      .rejects.toThrow(/boom 429/);
  });

  it('propagates a non-404, non-412 failure from a replace update', async () => {
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 11; i++) payload[`f${i}`] = i;
    await expect(withFailingMember('replace', 500).update({ id: 'o1', tenantId: 't1' }, payload))
      .rejects.toThrow(/boom 500/);
  });

  it('reports a missing row when a replace update finds it gone at read time', async () => {
    const source = withFailingMember('read', 404);
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 11; i++) payload[`f${i}`] = i;
    await expect(source.update({ id: 'o1', tenantId: 't1' }, payload))
      .rejects.toThrow(/boom 404/);
  });
});

describe('pure helpers', () => {
  it('partitionsByPrimaryKey accepts only a single-segment key naming the id', () => {
    const target = resolveCosmosTarget('Order', undefined);
    expect(partitionsByPrimaryKey({ paths: [['id']] }, target)).toBe(true);
    expect(partitionsByPrimaryKey({ paths: [['tenantId']] }, target)).toBe(false);
    expect(partitionsByPrimaryKey({ paths: [['a'], ['b']] }, target)).toBe(false);
    expect(partitionsByPrimaryKey({ paths: [['a', 'b']] }, target)).toBe(false);
  });

  it('conjoinFilters prefers the single expression over a one-child group', () => {
    const left = { type: 'comparison', field: 'a', operator: 'eq', value: 1 } as const;
    const right = { type: 'comparison', field: 'b', operator: 'eq', value: 2 } as const;
    expect(conjoinFilters(undefined, undefined)).toBeUndefined();
    expect(conjoinFilters(left, undefined)).toBe(left);
    expect(conjoinFilters(undefined, right)).toBe(right);
    expect(conjoinFilters(left, right)).toEqual({ type: 'and', filters: [left, right] });
  });

  it('statusOf reads a numeric code and nothing else', () => {
    expect(statusOf({ code: 404 })).toBe(404);
    expect(statusOf({ code: 'nope' })).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf('error')).toBeUndefined();
  });

  it('missingRow names the container and the key', () => {
    expect(missingRow(resolveCosmosTarget('Order', undefined), 'o1').message)
      .toContain('no Order row with id "o1"');
  });
});
