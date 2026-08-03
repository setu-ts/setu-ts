/**
 * The pure D1 SQL builders.
 *
 * Generated text is asserted **verbatim** rather than through a fake, so the
 * statement is pinned independently of how any double chooses to interpret it.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@hono-enterprise/common';

import { CloudflareUnsupportedError } from '../../../src/index.ts';
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildSelectById,
  buildUpdate,
  D1_MAX_BOUND_PARAMS,
  quoteIdentifier,
} from '../../../src/database/d1-sql.ts';

const TARGET = { table: 'users', primaryKey: 'id' } as const;

/** A normalized query with every field at its documented default. */
function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return { where: {}, orderBy: {}, limit: -1, offset: 0, select: [], ...partial };
}

describe('quoteIdentifier', () => {
  it('double-quotes a bare identifier', () => {
    expect(quoteIdentifier('user_id', 'column')).toBe('"user_id"');
  });

  it('rejects an identifier carrying SQL punctuation, naming its position', () => {
    expect(() => quoteIdentifier('id; DROP TABLE users --', 'filter column')).toThrow(
      CloudflareUnsupportedError,
    );
    expect(() => quoteIdentifier('id; DROP TABLE users --', 'filter column')).toThrow(
      /filter column/,
    );
  });

  it('rejects an identifier starting with a digit, and an empty one', () => {
    expect(() => quoteIdentifier('2fa', 'column')).toThrow(CloudflareUnsupportedError);
    expect(() => quoteIdentifier('', 'column')).toThrow(CloudflareUnsupportedError);
  });
});

describe('buildSelect', () => {
  it('selects every column with no clauses when the query is empty', () => {
    expect(buildSelect(TARGET, query())).toEqual({
      sql: 'SELECT * FROM "users"',
      params: [],
    });
  });

  it('projects only the selected columns', () => {
    expect(buildSelect(TARGET, query({ select: ['id', 'name'] })).sql).toBe(
      'SELECT "id", "name" FROM "users"',
    );
  });

  it('binds every where value and numbers the placeholders in order', () => {
    expect(buildSelect(TARGET, query({ where: { name: 'ada', age: 36 } }))).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1 AND "age" = ?2',
      params: ['ada', 36],
    });
  });

  it('compares null with IS NULL rather than = ?, which never matches', () => {
    expect(buildSelect(TARGET, query({ where: { deletedAt: null } }))).toEqual({
      sql: 'SELECT * FROM "users" WHERE "deletedAt" IS NULL',
      params: [],
    });
  });

  it('mixes a null check with bound values, keeping placeholder numbering right', () => {
    expect(buildSelect(TARGET, query({ where: { deletedAt: null, name: 'ada' } }))).toEqual({
      sql: 'SELECT * FROM "users" WHERE "deletedAt" IS NULL AND "name" = ?1',
      params: ['ada'],
    });
  });

  it('orders by each field in the given direction', () => {
    expect(buildSelect(TARGET, query({ orderBy: { age: 'desc', name: 'asc' } })).sql).toBe(
      'SELECT * FROM "users" ORDER BY "age" DESC, "name" ASC',
    );
  });

  it('binds a positive limit', () => {
    expect(buildSelect(TARGET, query({ limit: 20 }))).toEqual({
      sql: 'SELECT * FROM "users" LIMIT ?1',
      params: [20],
    });
  });

  it('emits LIMIT -1 for an offset with no limit, since SQLite rejects a bare OFFSET', () => {
    expect(buildSelect(TARGET, query({ offset: 10 }))).toEqual({
      sql: 'SELECT * FROM "users" LIMIT -1 OFFSET ?1',
      params: [10],
    });
  });

  it('combines limit and offset', () => {
    expect(buildSelect(TARGET, query({ limit: 5, offset: 10 }))).toEqual({
      sql: 'SELECT * FROM "users" LIMIT ?1 OFFSET ?2',
      params: [5, 10],
    });
  });

  it('composes every clause in SQL order', () => {
    expect(
      buildSelect(
        TARGET,
        query({ select: ['id'], where: { active: true }, orderBy: { id: 'asc' }, limit: 2 }),
      ),
    ).toEqual({
      sql: 'SELECT "id" FROM "users" WHERE "active" = ?1 ORDER BY "id" ASC LIMIT ?2',
      params: [true, 2],
    });
  });

  it('rejects an injected table, filter, order and select identifier', () => {
    const bad = 'x" OR "1"="1';
    expect(() => buildSelect({ table: bad, primaryKey: 'id' }, query())).toThrow(
      CloudflareUnsupportedError,
    );
    expect(() => buildSelect(TARGET, query({ where: { [bad]: 1 } }))).toThrow(
      CloudflareUnsupportedError,
    );
    expect(() => buildSelect(TARGET, query({ orderBy: { [bad]: 'asc' } }))).toThrow(
      CloudflareUnsupportedError,
    );
    expect(() => buildSelect(TARGET, query({ select: [bad] }))).toThrow(
      CloudflareUnsupportedError,
    );
  });

  it('accepts exactly the parameter budget and refuses one more', () => {
    const atLimit = Object.fromEntries(
      Array.from({ length: D1_MAX_BOUND_PARAMS }, (_, i) => [`c${i}`, i]),
    );
    expect(buildSelect(TARGET, query({ where: atLimit })).params).toHaveLength(
      D1_MAX_BOUND_PARAMS,
    );

    const overLimit = { ...atLimit, one_too_many: 1 };
    expect(() => buildSelect(TARGET, query({ where: overLimit }))).toThrow(
      CloudflareUnsupportedError,
    );
    expect(() => buildSelect(TARGET, query({ where: overLimit }))).toThrow(/101 parameters/);
  });
});

describe('buildSelectById', () => {
  it('filters on the configured primary key', () => {
    expect(buildSelectById({ table: 'users', primaryKey: 'user_id' }, 'u1')).toEqual({
      sql: 'SELECT * FROM "users" WHERE "user_id" = ?1 LIMIT 1',
      params: ['u1'],
    });
  });
});

describe('buildInsert', () => {
  it('returns the persisted row so generated columns reach the caller', () => {
    expect(buildInsert(TARGET, { id: 'u1', name: 'ada' })).toEqual({
      sql: 'INSERT INTO "users" ("id", "name") VALUES (?1, ?2) RETURNING *',
      params: ['u1', 'ada'],
    });
  });

  it('refuses an empty row', () => {
    expect(() => buildInsert(TARGET, {})).toThrow(CloudflareUnsupportedError);
  });

  it('rejects an injected column name', () => {
    expect(() => buildInsert(TARGET, { 'a" , "b': 1 })).toThrow(CloudflareUnsupportedError);
  });

  it('refuses a row wider than the parameter budget', () => {
    const wide = Object.fromEntries(
      Array.from({ length: D1_MAX_BOUND_PARAMS + 1 }, (_, i) => [`c${i}`, i]),
    );
    expect(() => buildInsert(TARGET, wide)).toThrow(/insert would bind 101 parameters/);
  });
});

describe('buildUpdate', () => {
  it('assigns each column then filters on the key, with the key bound last', () => {
    expect(buildUpdate(TARGET, 'u1', { name: 'ada', age: 36 })).toEqual({
      sql: 'UPDATE "users" SET "name" = ?1, "age" = ?2 WHERE "id" = ?3 RETURNING *',
      params: ['ada', 36, 'u1'],
    });
  });

  it('refuses an empty patch', () => {
    expect(() => buildUpdate(TARGET, 'u1', {})).toThrow(CloudflareUnsupportedError);
  });

  it('counts the key against the parameter budget', () => {
    const patch = Object.fromEntries(
      Array.from({ length: D1_MAX_BOUND_PARAMS }, (_, i) => [`c${i}`, i]),
    );
    // 100 columns + the key = 101 bound values.
    expect(() => buildUpdate(TARGET, 'u1', patch)).toThrow(/101 parameters/);
  });
});

describe('buildDelete', () => {
  it('returns the key, which is how a delete reports whether anything matched', () => {
    expect(buildDelete({ table: 'users', primaryKey: 'user_id' }, 7)).toEqual({
      sql: 'DELETE FROM "users" WHERE "user_id" = ?1 RETURNING "user_id"',
      params: [7],
    });
  });
});

describe('buildCount', () => {
  it('counts every row when unfiltered', () => {
    expect(buildCount(TARGET, {})).toEqual({
      sql: 'SELECT COUNT(*) AS "count" FROM "users"',
      params: [],
    });
  });

  it('applies the filter', () => {
    expect(buildCount(TARGET, { active: true })).toEqual({
      sql: 'SELECT COUNT(*) AS "count" FROM "users" WHERE "active" = ?1',
      params: [true],
    });
  });

  it('refuses a filter wider than the parameter budget', () => {
    const wide = Object.fromEntries(
      Array.from({ length: D1_MAX_BOUND_PARAMS + 1 }, (_, i) => [`c${i}`, i]),
    );
    expect(() => buildCount(TARGET, wide)).toThrow(/count would bind 101 parameters/);
  });
});
