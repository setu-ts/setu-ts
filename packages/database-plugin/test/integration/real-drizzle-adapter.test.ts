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
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
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
      drizzleInstance: database,
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
      drizzleInstance: database,
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

    expect(calls[0]?.sql).toContain('like $1');
    expect(calls[0]?.params).toEqual(['%50\\%\\_off\\\\now%']);
  });
});
