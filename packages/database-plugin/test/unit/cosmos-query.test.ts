/**
 * Unit tests for the pure Cosmos SQL builder.
 *
 * The builder emits text, so every branch is asserted as text here; that the
 * emitted text is ACCEPTED and answers correctly is proven separately, against
 * the real emulator, in `test/integration/real-cosmos-adapter.test.ts`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { FilterExpression, NormalizedQuery } from '@setu-ts/common';
import {
  buildCountQuery,
  buildIdLookupQuery,
  buildQuery,
  fieldExpression,
  normalizeValue,
} from '../../src/adapters/cosmos/cosmos-query.ts';
import { resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';

const target = resolveCosmosTarget('Order', undefined);
const mappedTarget = resolveCosmosTarget('Order', { Order: { primaryKey: 'orderId' } });

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

describe('normalizeValue', () => {
  it('converts a Date to the ISO string the SDK stores', () => {
    expect(normalizeValue(new Date('2026-05-05T00:00:00.000Z')))
      .toBe('2026-05-05T00:00:00.000Z');
  });

  it('passes every other value through', () => {
    expect(normalizeValue(7)).toBe(7);
    expect(normalizeValue(null)).toBeNull();
  });
});

describe('fieldExpression', () => {
  it('brackets a scalar field and a nested path', () => {
    expect(fieldExpression('name', target)).toBe('c["name"]');
    expect(fieldExpression(['address', 'city'], target)).toBe('c["address"]["city"]');
  });

  it('addresses the mapped primary key as the document id, including in a path head', () => {
    expect(fieldExpression('orderId', mappedTarget)).toBe('c["id"]');
    expect(fieldExpression(['orderId', 'x'], mappedTarget)).toBe('c["id"]["x"]');
  });

  it('refuses a field name carrying a double quote', () => {
    expect(() => fieldExpression('bad"name', target)).toThrow(/may not contain a double quote/);
  });
});

describe('buildQuery — projection, ordering and pagination', () => {
  it('selects the whole document as * rather than the container alias', () => {
    expect(buildQuery(query(), target).query).toBe('SELECT * FROM c');
  });

  it('emits exactly the requested fields, de-duplicated', () => {
    expect(buildQuery(query({ select: ['id', 'total', 'id'] }), target).query)
      .toBe('SELECT c["id"], c["total"] FROM c');
  });

  it('orders by every field in declaration order', () => {
    expect(buildQuery(query({ orderBy: { total: 'asc', name: 'desc' } }), target).query)
      .toBe('SELECT * FROM c ORDER BY c["total"] ASC, c["name"] DESC');
  });

  it('omits the pagination clause when unlimited from the first row', () => {
    expect(buildQuery(query({ limit: -1, offset: 0 }), target).query).toBe('SELECT * FROM c');
  });

  it('pairs an offset with the maximum limit when unlimited, because OFFSET needs LIMIT', () => {
    const built = buildQuery(query({ limit: -1, offset: 5 }), target);
    expect(built.query).toBe('SELECT * FROM c OFFSET @p0 LIMIT @p1');
    expect(built.parameters).toEqual([
      { name: '@p0', value: 5 },
      { name: '@p1', value: 2147483647 },
    ]);
  });

  it('binds an explicit offset and limit', () => {
    const built = buildQuery(query({ limit: 10, offset: 20 }), target);
    expect(built.parameters).toEqual([
      { name: '@p0', value: 20 },
      { name: '@p1', value: 10 },
    ]);
  });

  it('clamps a negative offset to zero', () => {
    const built = buildQuery(query({ limit: 3, offset: -4 }), target);
    expect(built.parameters[0]).toEqual({ name: '@p0', value: 0 });
  });
});

describe('buildQuery — filters', () => {
  it('binds an equality map', () => {
    const built = buildQuery(query({ where: { tenantId: 't1', total: 3 } }), target);
    expect(built.query).toBe('SELECT * FROM c WHERE c["tenantId"] = @p0 AND c["total"] = @p1');
    expect(built.parameters).toEqual([
      { name: '@p0', value: 't1' },
      { name: '@p1', value: 3 },
    ]);
  });

  it('emits every comparison operator', () => {
    const cases: [FilterExpression['type'] extends never ? never : FilterExpression, string][] = [
      [{ type: 'comparison', field: 'a', operator: 'eq', value: 1 }, 'c["a"] = @p0'],
      [{ type: 'comparison', field: 'a', operator: 'gt', value: 1 }, 'c["a"] > @p0'],
      [{ type: 'comparison', field: 'a', operator: 'gte', value: 1 }, 'c["a"] >= @p0'],
      [{ type: 'comparison', field: 'a', operator: 'lt', value: 1 }, 'c["a"] < @p0'],
      [{ type: 'comparison', field: 'a', operator: 'lte', value: 1 }, 'c["a"] <= @p0'],
    ];
    for (const [filter, expected] of cases) {
      expect(buildQuery(query({ filter }), target).query).toBe(`SELECT * FROM c WHERE ${expected}`);
    }
  });

  it('compiles contains to CONTAINS with the value bound and NOT escaped', () => {
    const built = buildQuery(
      query({
        filter: { type: 'comparison', field: 'name', operator: 'contains', value: '50% off' },
      }),
      target,
    );
    expect(built.query).toBe('SELECT * FROM c WHERE CONTAINS(c["name"], @p0)');
    // CONTAINS is a literal substring match, so `%` must reach the service intact.
    expect(built.parameters).toEqual([{ name: '@p0', value: '50% off' }]);
  });

  it('compiles in to ARRAY_CONTAINS binding one array parameter', () => {
    const built = buildQuery(
      query({ filter: { type: 'comparison', field: 'total', operator: 'in', value: [1, 2] } }),
      target,
    );
    expect(built.query).toBe('SELECT * FROM c WHERE ARRAY_CONTAINS(@p0, c["total"])');
    expect(built.parameters).toEqual([{ name: '@p0', value: [1, 2] }]);
  });

  it('binds an empty in list as an empty array, which matches nothing natively', () => {
    const built = buildQuery(
      query({ filter: { type: 'comparison', field: 'total', operator: 'in', value: [] } }),
      target,
    );
    expect(built.parameters).toEqual([{ name: '@p0', value: [] }]);
  });

  it('normalizes Date values inside an in list', () => {
    const built = buildQuery(
      query({
        filter: {
          type: 'comparison',
          field: 'at',
          operator: 'in',
          value: [new Date('2026-01-01T00:00:00.000Z')],
        },
      }),
      target,
    );
    expect(built.parameters).toEqual([{ name: '@p0', value: ['2026-01-01T00:00:00.000Z'] }]);
  });

  it('parenthesises and/or groups', () => {
    const filter: FilterExpression = {
      type: 'or',
      filters: [
        { type: 'comparison', field: 'a', operator: 'eq', value: 1 },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'b', operator: 'eq', value: 2 },
            { type: 'comparison', field: 'c', operator: 'eq', value: 3 },
          ],
        },
      ],
    };
    expect(buildQuery(query({ filter }), target).query)
      .toBe('SELECT * FROM c WHERE (c["a"] = @p0 OR (c["b"] = @p1 AND c["c"] = @p2))');
  });

  it('compiles an empty group to its boolean identity', () => {
    expect(buildQuery(query({ filter: { type: 'and', filters: [] } }), target).query)
      .toBe('SELECT * FROM c WHERE true');
    expect(buildQuery(query({ filter: { type: 'or', filters: [] } }), target).query)
      .toBe('SELECT * FROM c WHERE false');
  });

  it('conjoins the equality map with the portable filter', () => {
    const built = buildQuery(
      query({
        where: { tenantId: 't1' },
        filter: { type: 'comparison', field: 'total', operator: 'gt', value: 2 },
      }),
      target,
    );
    expect(built.query).toBe('SELECT * FROM c WHERE c["tenantId"] = @p0 AND c["total"] > @p1');
  });

  it('binds a Date comparison as its ISO string', () => {
    const built = buildQuery(
      query({
        filter: {
          type: 'comparison',
          field: 'createdAt',
          operator: 'gte',
          value: new Date('2026-02-03T04:05:06.000Z'),
        },
      }),
      target,
    );
    expect(built.parameters).toEqual([{ name: '@p0', value: '2026-02-03T04:05:06.000Z' }]);
  });
});

describe('buildCountQuery', () => {
  it('counts every row when nothing filters', () => {
    const built = buildCountQuery({}, undefined, target);
    expect(built.query).toBe('SELECT VALUE COUNT(1) FROM c');
    expect(built.parameters).toEqual([]);
  });

  it('applies the equality map and the portable filter', () => {
    const built = buildCountQuery(
      { tenantId: 't1' },
      { type: 'comparison', field: 'total', operator: 'lt', value: 9 },
      target,
    );
    expect(built.query)
      .toBe('SELECT VALUE COUNT(1) FROM c WHERE c["tenantId"] = @p0 AND c["total"] < @p1');
  });
});

describe('buildIdLookupQuery', () => {
  it('fetches two rows so an ambiguous id is distinguishable from a hit', () => {
    const built = buildIdLookupQuery('o1', mappedTarget);
    expect(built.query).toBe('SELECT * FROM c WHERE c["id"] = @p0 OFFSET 0 LIMIT 2');
    expect(built.parameters).toEqual([{ name: '@p0', value: 'o1' }]);
  });
});
