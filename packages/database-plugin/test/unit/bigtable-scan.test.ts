/**
 * The scan planner: what reaches the server, and what deliberately does not.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';
import { resolveBigtableTarget } from '../../src/adapters/bigtable/bigtable-mapping.ts';
import { planBigtableScan } from '../../src/adapters/bigtable/bigtable-scan.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

const scalar = resolveBigtableTarget('User', undefined);
const composite = resolveBigtableTarget('Order', {
  Order: { rowKey: { fields: ['tenantId', 'orderId'] } },
});

/** Builds a fully-resolved query, so each case states only what it varies. */
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

describe('row-set derivation', () => {
  it('turns a fully pinned key into an exact key read', () => {
    const plan = planBigtableScan(scalar, query({ where: { id: 'u1' } }));
    expect(plan.read.keys).toEqual(['u1']);
    expect(plan.read.ranges).toBeUndefined();
  });

  it('turns a pinned prefix into a range with an EXCLUSIVE successor end', () => {
    const plan = planBigtableScan(composite, query({ where: { tenantId: 't1' } }));
    expect(plan.read.ranges).toEqual([{
      start: { value: 't1#', inclusive: true },
      end: { value: 't1$', inclusive: false },
    }]);
  });

  it('leaves the scan unbounded when no key field is pinned and no prefix is mapped', () => {
    const plan = planBigtableScan(scalar, query());
    expect(plan.read.ranges).toBeUndefined();
    expect(plan.read.keys).toBeUndefined();
  });

  it('scans only the mapped prefix when the entity declares one', () => {
    const prefixed = resolveBigtableTarget('Order', {
      Order: { rowKey: { fields: ['id'], prefix: 'o/' } },
    });
    const plan = planBigtableScan(prefixed, query());
    expect(plan.read.ranges).toEqual([{
      start: { value: 'o/', inclusive: true },
      end: { value: 'o0', inclusive: false },
    }]);
  });

  it('expands an `in` on the final key field into an explicit key list', () => {
    const plan = planBigtableScan(
      composite,
      query({
        where: { tenantId: 't1' },
        filter: { type: 'comparison', field: 'orderId', operator: 'in', value: ['a', 'b', 'a'] },
      }),
    );
    expect(plan.read.keys).toEqual(['t1#a', 't1#b']);
  });

  it('reports the query empty for an `in` naming no value', () => {
    const plan = planBigtableScan(
      scalar,
      query({ filter: { type: 'comparison', field: 'id', operator: 'in', value: [] } }),
    );
    expect(plan.empty).toBe(true);
  });

  it('reports the query empty for two contradictory `eq` values on one key field', () => {
    const plan = planBigtableScan(
      scalar,
      query({
        where: { id: 'u1' },
        filter: { type: 'comparison', field: 'id', operator: 'eq', value: 'u2' },
      }),
    );
    expect(plan.empty).toBe(true);
  });

  it('WIDENS rather than narrowing when a key value cannot be rendered', () => {
    // The superset invariant: a value the planner cannot render is a value the
    // server cannot be narrowed by, and the client-side evaluator still decides.
    const plan = planBigtableScan(
      composite,
      query({ where: { tenantId: { nested: true }, orderId: 'o1' } }),
    );
    expect(plan.empty).toBe(false);
    expect(plan.read.keys).toBeUndefined();
    expect(plan.read.ranges).toBeUndefined();
  });

  it('WIDENS when an `in` list carries an unrenderable value', () => {
    const plan = planBigtableScan(
      composite,
      query({
        where: { tenantId: 't1' },
        filter: { type: 'comparison', field: 'orderId', operator: 'in', value: ['a', {}] },
      }),
    );
    expect(plan.read.keys).toBeUndefined();
    expect(plan.read.ranges?.[0].start?.value).toBe('t1#');
  });

  it('does not push down an ordered comparison on a key field', () => {
    // A composed row key is a STRING, so a numeric key field does not sort
    // numerically inside it — pushing `gt` down would drop matching rows.
    const plan = planBigtableScan(
      scalar,
      query({ filter: { type: 'comparison', field: 'id', operator: 'gt', value: 9 } }),
    );
    expect(plan.read.ranges).toBeUndefined();
    expect(plan.read.keys).toBeUndefined();
  });

  it('reads conjunctive legs out of nested `and`s but never out of an `or`', () => {
    const pushed = planBigtableScan(
      scalar,
      query({
        filter: {
          type: 'and',
          filters: [{
            type: 'and',
            filters: [{ type: 'comparison', field: 'id', operator: 'eq', value: 'u1' }],
          }],
        },
      }),
    );
    expect(pushed.read.keys).toEqual(['u1']);

    const notPushed = planBigtableScan(
      scalar,
      query({
        filter: {
          type: 'or',
          filters: [{ type: 'comparison', field: 'id', operator: 'eq', value: 'u1' }],
        },
      }),
    );
    expect(notPushed.read.keys).toBeUndefined();
  });
});

describe('cursor start keys', () => {
  it('moves the lower bound of a range forward', () => {
    const plan = planBigtableScan(
      composite,
      query({ where: { tenantId: 't1' } }),
      { after: 't1#o5' },
    );
    expect(plan.read.ranges?.[0].start).toEqual({ value: 't1#o5', inclusive: false });
    expect(plan.read.ranges?.[0].end).toEqual({ value: 't1$', inclusive: false });
  });

  it('never moves the lower bound BACKWARD past the key constraints', () => {
    const plan = planBigtableScan(
      composite,
      query({ where: { tenantId: 't5' } }),
      { after: 't1#o5' },
    );
    expect(plan.read.ranges?.[0].start).toEqual({ value: 't5#', inclusive: true });
  });

  it('filters an explicit key list down to keys after the cursor', () => {
    const plan = planBigtableScan(
      composite,
      query({
        where: { tenantId: 't1' },
        filter: { type: 'comparison', field: 'orderId', operator: 'in', value: ['a', 'b', 'c'] },
      }),
      { after: 't1#a' },
    );
    expect(plan.read.keys).toEqual(['t1#b', 't1#c']);
  });

  it('reports empty when the cursor is past every key in the list', () => {
    const plan = planBigtableScan(
      scalar,
      query({ filter: { type: 'comparison', field: 'id', operator: 'in', value: ['a'] } }),
      { after: 'z' },
    );
    expect(plan.empty).toBe(true);
  });

  it('bounds an otherwise unbounded scan from the cursor', () => {
    const plan = planBigtableScan(scalar, query(), { after: 'u3' });
    expect(plan.read.ranges).toEqual([{ start: { value: 'u3', inclusive: false } }]);
  });

  it('leaves an already-empty plan empty', () => {
    const plan = planBigtableScan(
      scalar,
      query({ filter: { type: 'comparison', field: 'id', operator: 'in', value: [] } }),
      { after: 'a' },
    );
    expect(plan.empty).toBe(true);
  });
});

describe('value push-down', () => {
  it('wraps a non-key `eq` in a condition whose test is an exact BYTE range', () => {
    const plan = planBigtableScan(scalar, query({ where: { city: 'london' } }));
    expect(plan.read.filter).toEqual({
      condition: {
        test: [
          { family: 'cf' },
          { column: ['city'] },
          { value: { start: 's:london', end: 's:london' } },
        ],
        pass: [{ all: true }],
      },
    });
  });

  it('uses the byte-range form for a value carrying regex metacharacters', () => {
    // The SDK's string form is a REGEX — measured, `{ value: 'a.*b' }` matched
    // both `a.*b` and `axxb`. Nothing here may produce that shape.
    const plan = planBigtableScan(scalar, query({ where: { code: 'a.*b' } }));
    const filter = plan.read.filter as { condition: { test: readonly unknown[] } };
    expect(filter.condition.test[2]).toEqual({ value: { start: 's:a.*b', end: 's:a.*b' } });
  });

  it('nests one condition per conjunctive non-key `eq`', () => {
    const plan = planBigtableScan(scalar, query({ where: { city: 'london', role: 'admin' } }));
    const outer = plan.read.filter as { condition: { pass: readonly unknown[] } };
    expect(outer.condition.pass[0]).toHaveProperty('condition');
  });

  it('pushes nothing down for a path-addressed field or an undefined value', () => {
    const path = planBigtableScan(
      scalar,
      query({
        filter: { type: 'comparison', field: ['profile', 'city'], operator: 'eq', value: 'x' },
      }),
    );
    expect(path.read.filter).toBeUndefined();
    const absent = planBigtableScan(scalar, query({ where: { city: undefined } }));
    expect(absent.read.filter).toBeUndefined();
  });

  it('pushes nothing down for a key field, whose constraint is already the row set', () => {
    const plan = planBigtableScan(scalar, query({ where: { id: 'u1' } }));
    expect(plan.read.filter).toBeUndefined();
  });
});

describe('projection', () => {
  it('projects to the selected columns plus the key, filter and sort fields', () => {
    const plan = planBigtableScan(
      scalar,
      query({
        select: ['name'],
        orderBy: { id: 'asc' },
        filter: {
          type: 'or',
          filters: [
            { type: 'comparison', field: 'city', operator: 'contains', value: 'lon' },
            { type: 'comparison', field: ['profile', 'tier'], operator: 'eq', value: 'gold' },
          ],
        },
      }),
    );
    const interleave =
      (plan.read.filter as { interleave: readonly (readonly { column?: readonly string[] }[])[] })
        .interleave;
    const columns = interleave[0][0].column as readonly string[];
    // `id` because the key field's CELL is what preserves its type; `city` and
    // `profile` because the client-side evaluator still has to read them.
    expect([...columns].sort()).toEqual(['city', 'id', 'name', 'profile']);
    // The second arm is what keeps a row carrying NONE of those columns in the
    // answer: a filter that removes every cell removes the row.
    expect(interleave[1]).toEqual([{ row: { cellLimit: 1 } }]);
  });

  it('projects nothing away when the caller selected nothing', () => {
    const plan = planBigtableScan(scalar, query());
    expect(plan.read.filter).toBeUndefined();
  });

  it('strips values instead of projecting when the caller needs none', () => {
    const plan = planBigtableScan(scalar, query(), { stripValues: true });
    expect(plan.read.filter).toEqual({ value: { strip: true } });
  });

  it('keeps the projection inside the innermost condition pass', () => {
    const plan = planBigtableScan(
      scalar,
      query({ select: ['name'], where: { city: 'london' } }),
    );
    const filter = plan.read.filter as {
      condition: {
        pass: readonly { interleave: readonly (readonly { column?: readonly string[] }[])[] }[];
      };
    };
    const columns = filter.condition.pass[0].interleave[0][0].column as readonly string[];
    expect([...columns].sort()).toEqual(['city', 'id', 'name']);
  });
});

describe('limit push-down', () => {
  it('pushes the limit down only when every scanned row is a match', () => {
    expect(planBigtableScan(scalar, query({ limit: 5 })).read.limit).toBe(5);
    expect(planBigtableScan(scalar, query({ limit: 5 })).serverLimited).toBe(true);
  });

  it('withholds the limit when a client-side predicate still has to run', () => {
    const withWhere = planBigtableScan(scalar, query({ limit: 5, where: { city: 'london' } }));
    expect(withWhere.read.limit).toBeUndefined();
    expect(withWhere.serverLimited).toBe(false);
    const withFilter = planBigtableScan(
      scalar,
      query({
        limit: 5,
        filter: { type: 'comparison', field: 'age', operator: 'gt', value: 3 },
      }),
    );
    expect(withFilter.read.limit).toBeUndefined();
  });

  it('withholds an unlimited limit', () => {
    expect(planBigtableScan(scalar, query({ limit: -1 })).read.limit).toBeUndefined();
  });
});

describe('refusals', () => {
  it('refuses a non-zero offset by name, pointing at cursor pagination', () => {
    expect(() => planBigtableScan(scalar, query({ offset: 10 })))
      .toThrow(/no row offset/);
  });

  it('honours an empty sort and the full key ascending', () => {
    expect(() => planBigtableScan(scalar, query({ orderBy: {} }))).not.toThrow();
    expect(() => planBigtableScan(scalar, query({ orderBy: { id: 'asc' } }))).not.toThrow();
    expect(() =>
      planBigtableScan(composite, query({ orderBy: { tenantId: 'asc', orderId: 'asc' } }))
    ).not.toThrow();
  });

  it('refuses a descending sort, a non-key sort, and a strict key prefix', () => {
    for (
      const orderBy of [
        { id: 'desc' } as const,
        { name: 'asc' } as const,
      ]
    ) {
      expect(() => planBigtableScan(scalar, query({ orderBy })))
        .toThrow(UnsupportedQueryFeatureError);
    }
    expect(() => planBigtableScan(composite, query({ orderBy: { tenantId: 'asc' } })))
      .toThrow(/only be ordered by its row key/);
    expect(() =>
      planBigtableScan(composite, query({ orderBy: { orderId: 'asc', tenantId: 'asc' } }))
    ).toThrow(/only be ordered by its row key/);
  });
});
