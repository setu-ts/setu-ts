/**
 * Start-key cursor pagination.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDataSource, NormalizedQuery, PageResult } from '@setu-ts/common';
import { decodeCursor, encodeCursor, sortFingerprint } from '@setu-ts/common';
import { resolveBigtableTarget } from '../../src/adapters/bigtable/bigtable-mapping.ts';
import { createBigtableDataSource } from '../../src/adapters/bigtable/bigtable-data-source.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';

/** Builds a fully-resolved page query. */
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

/** Builds a data source over a fresh store. */
function setup(maxPageFetches?: number): { store: FakeBigtableStore; source: IDataSource } {
  const store = new FakeBigtableStore();
  const client = createFakeBigtableClient(store);
  const target = resolveBigtableTarget('User', undefined);
  const source = createBigtableDataSource(
    client.instance('i').table(target.table),
    target,
    maxPageFetches === undefined ? {} : { maxPageFetches },
  );
  return { store, source };
}

/** Walks every page, returning the ids seen in order. */
async function walk(
  source: IDataSource,
  base: Partial<NormalizedQuery>,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result: PageResult = await (source.findPage as (
      q: NormalizedQuery,
    ) => Promise<PageResult>)(
      query(cursor === undefined ? base : { ...base, cursor }),
    );
    ids.push(...result.rows.map((row) => String(row.id)));
    if (result.nextCursor === null) return ids;
    cursor = result.nextCursor;
  }
  throw new Error('walk did not terminate');
}

describe('findPage', () => {
  it('walks every row exactly once over deliberately TIED non-key values', async () => {
    const { source } = setup();
    // Six rows carrying only two distinct `rank` values: a walk that omitted
    // the key tiebreaker would return four of six and report success.
    for (const [id, rank] of [['u1', 1], ['u2', 1], ['u3', 1], ['u4', 2], ['u5', 2], ['u6', 2]]) {
      await source.create({ id, rank });
    }
    expect(await walk(source, { limit: 2 })).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  });

  it('answers an unlimited page as one terminal page', async () => {
    const { source } = setup();
    await source.create({ id: 'u1' });
    await source.create({ id: 'u2' });
    const page = await source.findPage?.(query());
    expect(page?.rows.map((r) => r.id)).toEqual(['u1', 'u2']);
    expect(page?.nextCursor).toBe(null);
  });

  it('carries a filter and a projection through the walk', async () => {
    const { source } = setup();
    for (let i = 1; i <= 6; i += 1) {
      await source.create({ id: `u${i}`, even: i % 2 === 0, name: `n${i}` });
    }
    const ids = await walk(source, {
      limit: 2,
      select: ['id'],
      filter: { type: 'comparison', field: 'even', operator: 'eq', value: true },
    });
    expect(ids).toEqual(['u2', 'u4', 'u6']);
    const first = await source.findPage?.(query({
      limit: 2,
      select: ['id'],
      filter: { type: 'comparison', field: 'even', operator: 'eq', value: true },
    }));
    expect(first?.rows[0]).toEqual({ id: 'u2' });
  });

  it('reports a bounded page as NON-terminal even when it carries zero rows', async () => {
    // maxPageFetches = 1 with a predicate no row in the first batch satisfies:
    // the page is empty AND further matching rows remain, which is exactly the
    // case a `rows.length`-derived cursor gets wrong.
    //
    // The predicate is an ORDERED comparison deliberately: an `eq` is pushed
    // down, so the server would answer with the matching row directly and the
    // zero-match batch this case exists for could never arise.
    const { source } = setup(1);
    for (let i = 1; i <= 6; i += 1) await source.create({ id: `u${i}`, rank: i });
    const filter = { type: 'comparison', field: 'rank', operator: 'gt', value: 5 } as const;
    const page = await source.findPage?.(query({ limit: 2, filter }));
    expect(page?.rows).toEqual([]);
    expect(page?.nextCursor).not.toBe(null);
    // And the walk still completes, because the cursor continues from the last
    // row SCANNED rather than the last row matched.
    expect(await walk(source, { limit: 2, filter })).toEqual(['u6']);
  });

  it('stops issuing reads once the range is exhausted', async () => {
    const { store, source } = setup();
    await source.create({ id: 'u1' });
    store.reads.length = 0;
    const page = await source.findPage?.(query({ limit: 5 }));
    expect(page?.nextCursor).toBe(null);
    expect(store.reads).toHaveLength(1);
  });

  it('refuses a malformed cursor token by name', async () => {
    const { source } = setup();
    await expect(source.findPage?.(query({ limit: 1, cursor: 'not-a-token!!' })))
      .rejects.toThrow(UnsupportedQueryFeatureError);
  });

  it('refuses a cursor minted under a different sort', async () => {
    const { source } = setup();
    const foreign = encodeCursor({
      orderedValues: ['u1'],
      keyValues: ['u1'],
      sortFingerprint: 'name:desc',
    });
    await expect(source.findPage?.(query({ limit: 1, cursor: foreign })))
      .rejects.toThrow(/minted under sort 'name:desc'/);
  });

  it('refuses a cursor carrying the wrong number of key values', async () => {
    const store = new FakeBigtableStore();
    const client = createFakeBigtableClient(store);
    const target = resolveBigtableTarget('Order', {
      Order: { rowKey: { fields: ['tenantId', 'orderId'] } },
    });
    const source = createBigtableDataSource(client.instance('i').table('Order'), target);
    const shortCursor = encodeCursor({
      orderedValues: [],
      keyValues: ['t1'],
      sortFingerprint: sortFingerprint({}),
    });
    await expect(source.findPage?.(query({ limit: 1, cursor: shortCursor })))
      .rejects.toThrow(/1 key values for a 2-field row key/);
  });

  it('accepts a cursor minted under the explicit key sort', async () => {
    const { source } = setup();
    await source.create({ id: 'u1' });
    await source.create({ id: 'u2' });
    const first = await source.findPage?.(query({ limit: 1, orderBy: { id: 'asc' } }));
    expect(first?.nextCursor).not.toBe(null);
    const second = await source.findPage?.(
      query({ limit: 1, orderBy: { id: 'asc' }, cursor: first?.nextCursor as string }),
    );
    expect(second?.rows.map((r) => r.id)).toEqual(['u2']);
  });

  it('mints a numeric key value as a NUMBER, from the cell rather than the row key', async () => {
    // The row key is bytes and records no type, so the key field's CELL is what
    // preserves it — which is why the projection always keeps the key
    // qualifiers even when the caller's `select` names none.
    //
    // The key field is named `zid` deliberately: cells come back in
    // lexicographic qualifier order, so a key sorting FIRST would be rescued by
    // the projection's one-cell arm and the assertion would hold whether the
    // key qualifiers were kept or not.
    const store = new FakeBigtableStore();
    const client = createFakeBigtableClient(store);
    const target = resolveBigtableTarget('Row', { Row: { rowKey: { fields: ['zid'] } } });
    const source = createBigtableDataSource(client.instance('i').table('Row'), target);
    await source.create({ zid: 7, name: 'ada' });
    await source.create({ zid: 8, name: 'bob' });
    const page = await source.findPage?.(query({ limit: 1, select: ['name'] }));
    expect(page?.rows).toEqual([{ name: 'ada' }]);
    expect(decodeCursor(page?.nextCursor as string)?.keyValues).toEqual([7]);
  });

  it('answers an empty terminal page for a contradictory page query', async () => {
    const { source } = setup();
    await source.create({ id: 'u1' });
    const page = await source.findPage?.(query({
      limit: 2,
      where: { id: 'u1' },
      filter: { type: 'comparison', field: 'id', operator: 'eq', value: 'zz' },
    }));
    expect(page).toEqual({ rows: [], nextCursor: null });
    const unlimited = await source.findPage?.(query({
      where: { id: 'u1' },
      filter: { type: 'comparison', field: 'id', operator: 'eq', value: 'zz' },
    }));
    expect(unlimited).toEqual({ rows: [], nextCursor: null });
  });
});
