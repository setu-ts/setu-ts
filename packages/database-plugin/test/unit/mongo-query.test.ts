/**
 * Coverage for the pure `NormalizedQuery` → native-driver translation.
 *
 * Exercises every member of `NormalizedQuery`, every `FilterComparison`
 * operator, `and`/`or`, an empty `in`, an `in` containing `null`, and the
 * `limit: -1` → no-limit edge, so `mongo-query.ts` clears the 90% bar without a
 * server.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { FilterComparison, FilterExpression, NormalizedQuery } from '@setu-ts/common';
import {
  escapeRegex,
  translateComparison,
  translateCountFilter,
  translateFilter,
  translateQuery,
} from '../../src/adapters/mongo/mongo-query.ts';

function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    where: partial.where ?? {},
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
  };
}

describe('translateQuery — every NormalizedQuery member maps natively', () => {
  it('carries the equality `where` into the match filter', () => {
    const { filter } = translateQuery(query({ where: { name: 'Bolt' } }));
    expect(filter).toEqual({ name: 'Bolt' });
  });

  it('maps orderBy → sort', () => {
    const { options } = translateQuery(query({ orderBy: { name: 'desc' } }));
    expect(options.sort).toEqual({ name: 'desc' });
  });

  it('maps offset → skip and limit → limit', () => {
    const { options } = translateQuery(query({ offset: 2, limit: 5 }));
    expect(options.skip).toBe(2);
    expect(options.limit).toBe(5);
  });

  it('maps limit: -1 to no limit option at all', () => {
    const { options } = translateQuery(query({ limit: -1 }));
    expect(options.limit).toBeUndefined();
  });

  it('maps select → a projection of field → 1', () => {
    const { options } = translateQuery(query({ select: ['name', 'role'] }));
    expect(options.projection).toEqual({ name: 1, role: 1 });
  });

  it('produces no options for a bare query', () => {
    const { options } = translateQuery(query());
    expect(options).toEqual({});
  });

  it('combines every clause into one filter + options', () => {
    const { filter, options } = translateQuery({
      where: { active: true },
      filter: {
        type: 'comparison',
        field: 'score',
        operator: 'gte',
        value: 80,
      },
      orderBy: { score: 'desc' },
      limit: 10,
      offset: 20,
      select: ['score'],
    } as NormalizedQuery);
    expect(filter).toEqual({ active: true, score: { $gte: 80 } });
    expect(options).toEqual({
      sort: { score: 'desc' },
      skip: 20,
      limit: 10,
      projection: { score: 1 },
    });
  });
});

describe('translateFilter — and/or and nested comparisons', () => {
  it('maps an and to $and', () => {
    const expression: FilterExpression = {
      type: 'and',
      filters: [
        { type: 'comparison', field: 'a', operator: 'eq', value: 1 },
        { type: 'comparison', field: 'b', operator: 'gt', value: 2 },
      ],
    };
    expect(translateFilter(expression)).toEqual({
      $and: [{}, { b: { $gt: 2 } }],
    });
  });

  it('maps an or to $or', () => {
    const expression: FilterExpression = {
      type: 'or',
      filters: [{ type: 'comparison', field: 'a', operator: 'gt', value: 1 }],
    };
    expect(translateFilter(expression)).toEqual({ $or: [{ a: { $gt: 1 } }] });
  });

  it('folds a nested field comparison under its field name', () => {
    const expression: FilterComparison = {
      type: 'comparison',
      field: 'age',
      operator: 'lte',
      value: 30,
    };
    expect(translateFilter(expression)).toEqual({ age: { $lte: 30 } });
  });
});

describe('translateComparison — every operator maps', () => {
  const comparison = (
    operator: FilterComparison['operator'],
    value: unknown,
  ): FilterComparison => ({
    type: 'comparison',
    field: 'x',
    operator,
    value,
  } as FilterComparison);

  it('eq returns undefined — equality is carried by where', () => {
    expect(translateComparison(comparison('eq', 1))).toBeUndefined();
  });

  it('contains → $regex with an escaped value and empty $options', () => {
    expect(translateComparison(comparison('contains', '3.5'))).toEqual({
      $regex: '3\\.5',
      $options: '',
    });
  });

  it('gt/gte/lt/lte map to $gt/$gte/$lt/$lte', () => {
    expect(translateComparison(comparison('gt', 5))).toEqual({ $gt: 5 });
    expect(translateComparison(comparison('gte', 5))).toEqual({ $gte: 5 });
    expect(translateComparison(comparison('lt', 5))).toEqual({ $lt: 5 });
    expect(translateComparison(comparison('lte', 5))).toEqual({ $lte: 5 });
  });

  it('in → $in spreading the value list', () => {
    expect(translateComparison(comparison('in', [1, 2, 3]))).toEqual({ $in: [1, 2, 3] });
  });

  it('an empty in → $in: [] (match nothing)', () => {
    expect(translateComparison(comparison('in', []))).toEqual({ $in: [] });
  });

  it('an in containing null keeps the null', () => {
    expect(translateComparison(comparison('in', [null, 'a']))).toEqual({
      $in: [null, 'a'],
    });
  });
});

describe('translateCountFilter — where + optional filter', () => {
  it('starts from where and merges a filter', () => {
    const doc = translateCountFilter(
      { active: true },
      { type: 'comparison', field: 'age', operator: 'gte', value: 18 },
    );
    expect(doc).toEqual({ active: true, age: { $gte: 18 } });
  });

  it('returns just where when no filter is supplied', () => {
    expect(translateCountFilter({ name: 'Bolt' })).toEqual({ name: 'Bolt' });
  });
});

describe('escapeRegex — the metacharacters the driver treats specially', () => {
  it('escapes . * + ? ^ $ { } ( ) | [ ] \\', () => {
    expect(escapeRegex('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });

  it('leaves a plain value untouched', () => {
    expect(escapeRegex('plainvalue')).toBe('plainvalue');
  });

  it('escapes a literal dot so 3.5 does not match 315', () => {
    const escaped = escapeRegex('3.5');
    expect(new RegExp(escaped).test('315')).toBe(false);
    expect(new RegExp(escaped).test('3.5')).toBe(true);
  });
});
