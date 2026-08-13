/**
 * Real Drizzle query-builder integration proof.
 *
 * The proxy driver performs no network I/O, but it runs Drizzle's actual
 * PostgreSQL SQL generator. That makes a fabricated `{ column: 'id' }`
 * expression fail this test while keeping the suite database-server-free.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { drizzle } from 'npm:drizzle-orm@0.45.2/pg-proxy';
import { pgTable, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import { drizzle as sqliteDrizzle } from 'npm:drizzle-orm@0.45.2/sqlite-proxy';
import { sqliteTable, text as sqliteText } from 'npm:drizzle-orm@0.45.2/sqlite-core';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'npm:drizzle-orm@0.45.2';
import { DatabaseSync } from 'node:sqlite';
import {
  createDrizzleDataSource,
  DrizzleAdapter,
} from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createDrizzleDatabase } from '../../src/index.ts';
import type { NormalizedQuery } from '@setu-ts/common';

const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
});

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

describe('DrizzleAdapter with the real Drizzle SQL generator', () => {
  it('uses real columns for every repository operation', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[]; method: string }> = [];
    const database = drizzle((sql, params, method) => {
      calls.push({ sql, params, method });
      // A count query answers with one aggregate row; everything else is empty.
      return Promise.resolve({ rows: sql.includes('count(*)') ? [['4']] : [] });
    });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(database),
      drizzleTables: { User: users },
    });
    await adapter.connect();
    const source = adapter.createDataSource('User');

    let counted = 0;

    await source.findById('u1');
    await source.findAll(query({
      where: { role: 'admin' },
      orderBy: { name: 'desc' },
      limit: 2,
      offset: 1,
      select: ['name'],
    }));
    counted = await source.count({ role: 'admin' });
    await expect(source.create({ id: 'u1', name: 'Ada', role: 'admin' })).rejects.toThrow(
      'returned no row',
    );
    await expect(source.update('u1', { name: 'Ada Lovelace' })).rejects.toThrow('not found');
    expect(await source.delete('u1')).toBe(false);

    expect(calls.map((call) => call.sql)).toEqual([
      expect.stringContaining('"users"."id"'),
      expect.stringContaining('"users"."role"'),
      expect.stringContaining('"users"."role"'),
      expect.stringContaining('insert into "users"'),
      expect.stringContaining('update "users"'),
      expect.stringContaining('delete from "users"'),
    ]);
    expect(calls[0]?.params).toEqual(['u1']);
    expect(calls[1]?.sql).toContain('order by "users"."name" desc');
    expect(calls[1]?.sql).toContain('limit $2 offset $3');
    expect(calls[1]?.params).toEqual(['admin', 2, 1]);

    // count() must aggregate in the database. Selecting the rows and measuring
    // the result set in JavaScript would pass every fake-backed test while
    // dragging the whole match set over the wire on a real server.
    expect(calls[2]?.sql).toContain('count(*)');
    expect(calls[2]?.sql).not.toContain('"users"."name"');
    expect(calls[2]?.params).toEqual(['admin']);
    expect(counted).toBe(4);
  });

  it('binds an escaped literal contains pattern', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const database = drizzle((sql, params) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows: [] });
    });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(database),
      drizzleTables: { User: users },
    });
    await adapter.connect();

    await adapter.createDataSource('User').findAll(query({
      filter: {
        type: 'comparison',
        field: 'name',
        operator: 'contains',
        value: '50%_off\\now',
      },
    }));

    expect(calls[0]?.sql).toContain("like $1 escape '\\'");
    expect(calls[0]?.params).toEqual(['%50\\%\\_off\\\\now%']);
  });

  it('matches a metacharacter search literally when executed on real SQLite', async () => {
    // The dialect this proves against is the point. Postgres and MySQL treat a
    // backslash as the default LIKE escape, so escaping the pattern happens to
    // be enough there and this file's other cases cannot tell the difference.
    // SQLite defines NO default escape character, so the search is literal
    // only because of the emitted `ESCAPE '\'` clause — drop the clause and
    // this returns zero rows.
    //
    // It runs through `createDrizzleDataSource` rather than `DrizzleAdapter`
    // because the adapter's structural check requires `execute`, which the
    // SQLite drivers do not expose; the data source is where the predicate is
    // built, and it is public API in its own right.
    const sqliteUsers = sqliteTable('users', {
      id: sqliteText('id').primaryKey(),
      name: sqliteText('name').notNull(),
    });
    const engine = new DatabaseSync(':memory:');
    engine.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)');
    engine.exec(
      "INSERT INTO users VALUES ('u1','50%_off now'), ('u2','50XYoff now'), ('u3','ADA')",
    );

    const database = sqliteDrizzle((statement, params) => {
      const rows = engine.prepare(statement).all(...(params as string[]));
      return Promise.resolve({ rows: rows.map((row) => Object.values(row)) });
    });
    const source = createDrizzleDataSource(
      // The SQLite drivers expose no `execute`, so this instance does not
      // satisfy `DrizzleInstance` — which is exactly why `DrizzleAdapter`
      // refuses one. The read path under test only uses `select`.
      database as unknown as Parameters<typeof createDrizzleDataSource>[0],
      'User',
      { User: sqliteUsers },
      // Drizzle's own operators take `SQLWrapper`, so they are not assignable
      // to the adapter's structural `(col: unknown, …)` signatures — the
      // adapter casts them the same way when it loads the namespace.
      {
        eq,
        and,
        or,
        gt,
        gte,
        lt,
        lte,
        inArray,
        isNull,
        sql,
        asc,
        desc,
        count,
      } as unknown as Parameters<typeof createDrizzleDataSource>[3],
    );

    const found = await source.findAll(query({
      select: ['id'],
      filter: { type: 'comparison', field: 'name', operator: 'contains', value: '50%_off' },
    }));

    // `50XYoff now` is the negative control: it is exactly what an unescaped
    // `%_` wildcard pattern would also return.
    expect(found.map((row) => row.id)).toEqual(['u1']);
  });
});
