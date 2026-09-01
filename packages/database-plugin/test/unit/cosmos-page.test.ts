/**
 * Unit tests for the Cosmos keyset page: the one-extra-row probe, the
 * projection widening and narrowing, and the three refusals.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';
import { encodeCursor, sortFingerprint } from '@setu-ts/common';
import { createCosmosDataSource } from '../../src/adapters/cosmos/cosmos-data-source.ts';
import { resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { PartitionKeyResolver } from '../../src/adapters/cosmos/cosmos-partition-key.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';

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

function makeSource(rows: Record<string, unknown>[][]) {
  const fake = createFakeCosmosClient({
    containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
    queryResults: rows,
  });
  const database = fake.client.database('db');
  const source = createCosmosDataSource({
    database,
    target: resolveCosmosTarget('Order', undefined),
    partitionKeys: new PartitionKeyResolver(database),
  });
  return { fake, source };
}

describe('findPage', () => {
  it('fetches one extra row and mints a cursor when a further page exists', async () => {
    const { source, fake } = makeSource([[
      { id: 'a', rank: 1 },
      { id: 'b', rank: 1 },
      { id: 'c', rank: 2 },
    ]]);
    const page = await source.findPage?.(query({ orderBy: { rank: 'asc' }, limit: 2 }));
    expect(page?.rows.map((row) => row['id'])).toEqual(['a', 'b']);
    expect(page?.nextCursor).not.toBeNull();
    // The probe asks for limit + 1.
    expect(fake.recorder.queries[0]?.parameters.at(-1)).toEqual({ name: '@p1', value: 3 });
  });

  it('reports a null cursor on the last page', async () => {
    const { source } = makeSource([[{ id: 'a', rank: 1 }]]);
    const page = await source.findPage?.(query({ orderBy: { rank: 'asc' }, limit: 2 }));
    expect(page?.rows).toHaveLength(1);
    expect(page?.nextCursor).toBeNull();
  });

  it('orders by the key column as a tiebreaker, so tied sort values cannot repeat', async () => {
    const { source, fake } = makeSource([[{ id: 'a', rank: 1 }]]);
    await source.findPage?.(query({ orderBy: { rank: 'asc' }, limit: 5 }));
    expect(fake.recorder.queries[0]?.query)
      .toContain('ORDER BY c["rank"] ASC, c["id"] ASC');
  });

  it('widens the projection to the key and ordered columns, then narrows it back', async () => {
    const { source, fake } = makeSource([[{ id: 'a', rank: 1, name: 'n' }]]);
    const page = await source.findPage?.(
      query({ orderBy: { rank: 'asc' }, limit: 5, select: ['name'] }),
    );
    expect(fake.recorder.queries[0]?.query)
      .toBe(
        'SELECT c["name"], c["id"], c["rank"] FROM c ORDER BY c["rank"] ASC, c["id"] ASC OFFSET @p0 LIMIT @p1',
      );
    // The caller asked for `name` alone and gets exactly that.
    expect(page?.rows).toEqual([{ name: 'n' }]);
  });

  it('conjoins the keyset predicate with the caller filter on a later page', async () => {
    const first = makeSource([[{ id: 'a', rank: 1 }, { id: 'b', rank: 1 }]]);
    const page = await first.source.findPage?.(query({ orderBy: { rank: 'asc' }, limit: 1 }));
    const cursor = page?.nextCursor as string;

    const second = makeSource([[]]);
    await second.source.findPage?.(query({
      orderBy: { rank: 'asc' },
      limit: 1,
      cursor,
      filter: { type: 'comparison', field: 'tenantId', operator: 'eq', value: 't1' },
    }));
    const emitted = second.fake.recorder.queries[0]?.query as string;
    expect(emitted).toContain('c["tenantId"] = ');
    expect(emitted).toContain('c["rank"] > ');
  });

  it('refuses a malformed cursor token by name', async () => {
    const { source } = makeSource([[]]);
    await expect(
      source.findPage?.(query({ orderBy: { rank: 'asc' }, limit: 1, cursor: 'not-a-cursor' })),
    )
      .rejects.toThrow(UnsupportedQueryFeatureError);
  });

  it('refuses a cursor minted under a different sort', async () => {
    const { source } = makeSource([[]]);
    const foreign = encodeCursor({
      orderedValues: [1],
      keyValues: ['a'],
      sortFingerprint: sortFingerprint({ other: 'desc' }),
    });
    await expect(source.findPage?.(query({ orderBy: { rank: 'asc' }, limit: 1, cursor: foreign })))
      .rejects.toThrow(/fingerprint mismatch/);
  });

  it('refuses an offset presented alongside a cursor', async () => {
    const { source } = makeSource([[{ id: 'a', rank: 1 }, { id: 'b', rank: 1 }]]);
    const page = await source.findPage?.(query({ orderBy: { rank: 'asc' }, limit: 1 }));
    await expect(
      source.findPage?.(
        query({
          orderBy: { rank: 'asc' },
          limit: 1,
          offset: 5,
          cursor: page?.nextCursor as string,
        }),
      ),
    ).rejects.toThrow();
  });
});
