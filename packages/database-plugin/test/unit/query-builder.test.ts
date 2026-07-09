/**
 * Unit tests for the query builder module.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  applyOrderBy,
  applyPagination,
  matchesWhere,
  normalizeCountOptions,
  normalizeQuery,
  projectFields,
} from '../../src/query/query-builder.ts';

describe('normalizeQuery', () => {
  it('returns defaults when no options provided', () => {
    const query = normalizeQuery();
    expect(query.where).toEqual({});
    expect(query.orderBy).toEqual({});
    expect(query.limit).toBe(-1);
    expect(query.offset).toBe(0);
    expect(query.select).toEqual([]);
  });

  it('preserves all options when provided', () => {
    const query = normalizeQuery({
      where: { active: true },
      orderBy: { name: 'asc' },
      limit: 10,
      offset: 20,
      select: ['id', 'name'],
    });
    expect(query.where).toEqual({ active: true });
    expect(query.orderBy).toEqual({ name: 'asc' });
    expect(query.limit).toBe(10);
    expect(query.offset).toBe(20);
    expect(query.select).toEqual(['id', 'name']);
  });

  it('fills missing options with defaults', () => {
    const query = normalizeQuery({ where: { id: '1' } });
    expect(query.where).toEqual({ id: '1' });
    expect(query.orderBy).toEqual({});
    expect(query.limit).toBe(-1);
    expect(query.offset).toBe(0);
    expect(query.select).toEqual([]);
  });
});

describe('normalizeCountOptions', () => {
  it('returns empty object when no options', () => {
    expect(normalizeCountOptions()).toEqual({});
  });

  it('returns where clause when provided', () => {
    expect(normalizeCountOptions({ where: { active: true } })).toEqual({ active: true });
  });
});

describe('matchesWhere', () => {
  it('returns true when all conditions match', () => {
    const entity = { id: '1', name: 'Alice', active: true };
    expect(matchesWhere(entity, { id: '1', active: true })).toBe(true);
  });

  it('returns true when where is empty', () => {
    const entity = { id: '1', name: 'Alice' };
    expect(matchesWhere(entity, {})).toBe(true);
  });

  it('returns false when one condition does not match', () => {
    const entity = { id: '1', name: 'Alice' };
    expect(matchesWhere(entity, { name: 'Bob' })).toBe(false);
  });

  it('returns false when entity lacks a filtered field', () => {
    const entity = { id: '1' };
    expect(matchesWhere(entity, { name: 'Alice' })).toBe(false);
  });
});

describe('applyOrderBy', () => {
  it('returns same array when orderBy is empty', () => {
    const items = [{ id: '2' }, { id: '1' }];
    const result = applyOrderBy(items, {});
    expect(result).toEqual(items);
  });

  it('sorts ascending by field', () => {
    const items = [{ name: 'Charlie' }, { name: 'Alice' }, { name: 'Bob' }];
    const result = applyOrderBy(items, { name: 'asc' });
    expect(result[0].name).toBe('Alice');
    expect(result[1].name).toBe('Bob');
    expect(result[2].name).toBe('Charlie');
  });

  it('sorts descending by field', () => {
    const items = [{ name: 'Charlie' }, { name: 'Alice' }, { name: 'Bob' }];
    const result = applyOrderBy(items, { name: 'desc' });
    expect(result[0].name).toBe('Charlie');
    expect(result[1].name).toBe('Bob');
    expect(result[2].name).toBe('Alice');
  });

  it('does not mutate original array', () => {
    const items = [{ name: 'Z' }, { name: 'A' }];
    const original = [...items];
    applyOrderBy(items, { name: 'asc' });
    expect(items).toEqual(original);
  });

  it('handles undefined values by pushing to end', () => {
    const items = [{ name: 'Alice' }, { name: undefined }, { name: 'Bob' }];
    const result = applyOrderBy(items, { name: 'asc' });
    expect(result[0].name).toBe('Alice');
    expect(result[1].name).toBe('Bob');
    expect(result[2].name).toBe(undefined);
  });
});

describe('applyPagination', () => {
  it('returns all items when offset is 0 and limit is -1', () => {
    const items = [1, 2, 3];
    expect(applyPagination(items, 0, -1)).toEqual([1, 2, 3]);
  });

  it('applies offset', () => {
    const items = [1, 2, 3, 4, 5];
    expect(applyPagination(items, 2, -1)).toEqual([3, 4, 5]);
  });

  it('applies limit', () => {
    const items = [1, 2, 3, 4, 5];
    expect(applyPagination(items, 0, 2)).toEqual([1, 2]);
  });

  it('applies both offset and limit', () => {
    const items = [1, 2, 3, 4, 5];
    expect(applyPagination(items, 1, 2)).toEqual([2, 3]);
  });

  it('returns empty when offset exceeds length', () => {
    const items = [1, 2];
    expect(applyPagination(items, 5, -1)).toEqual([]);
  });

  it('returns remaining items when limit exceeds available', () => {
    const items = [1, 2];
    expect(applyPagination(items, 0, 10)).toEqual([1, 2]);
  });
});

describe('projectFields', () => {
  it('returns all fields when select is empty', () => {
    const entity = { id: '1', name: 'Alice', email: 'a@b.com' };
    const result = projectFields(entity, []);
    expect(result).toEqual(entity);
  });

  it('returns only selected fields', () => {
    const entity = { id: '1', name: 'Alice', email: 'a@b.com' };
    const result = projectFields(entity, ['id', 'name']);
    expect(result).toEqual({ id: '1', name: 'Alice' });
  });

  it('ignores non-existent fields in select', () => {
    const entity = { id: '1', name: 'Alice' };
    const result = projectFields(entity, ['id', 'missing']);
    expect(result).toEqual({ id: '1' });
  });
});
