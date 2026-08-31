/**
 * One page, every data source — the cross-adapter conformance suite for the
 * shared cursor helpers (`findPage`, §3.8).
 *
 * Moving `sortFingerprint` / `mintNextCursor` / `keysetPredicate` into
 * `@setu-ts/common` was designed so the five adapters cannot drift about what
 * "the next page" means: every adapter builds the keyset predicate, mints the
 * cursor, and applies the tiebreaker with the SAME three helpers. This suite
 * proves that contract. It seeds one fixture into every data source, takes the
 * first page, and asserts that all five return the IDENTICAL rows and MINT THE
 * IDENTICAL cursor token — byte-for-byte, because the token is `encodeCursor`
 * over the last row's ordered + key values under the shared fingerprint.
 *
 * Why the FIRST page only: the faithful multi-page keyset walk is exercised per
 * adapter in each adapter's own `findPage` suite, and (for the adapters the
 * fakes cannot model faithfully) against the real engine — D1 against
 * `node:sqlite`, Mongo against a real server, Prisma against live PostgreSQL,
 * per the §8 risk in the milestone plan. The Drizzle fake only sorts by the
 * first column and drops the keyset predicate; the Mongo fake only sorts by the
 * first column and re-reads tied rows — both are faithful models of those
 * drivers' actual limitations, not defects to paper over. A multi-page walk
 * through those fakes would assert a behaviour the fakes themselves do not
 * implement. The first page, however, is exactly what the shared helpers
 * guarantee, and it is faithful across all five.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';

import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { createDrizzleDataSource } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createMongoDataSource } from '../../src/adapters/mongo/mongo-data-source.ts';
import { createD1DataSource } from '../../../cloudflare-plugin/src/database/d1-data-source.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import { FakeMongoClient, fakeObjectIdCtor } from '../fixtures/fake-mongo-client.ts';
import { SqliteD1 } from '../../../cloudflare-plugin/test/d1-fakes.ts';

/** The shared fixture: distinct `score` values make the first page unambiguous. */
const SEED = [
  { id: 'a', name: 'alpha', score: 1 },
  { id: 'b', name: 'bravo', score: 2 },
  { id: 'c', name: 'charlie', score: 3 },
  { id: 'd', name: 'delta', score: 4 },
  { id: 'e', name: 'echo', score: 5 },
  { id: 'f', name: 'foxtrot', score: 6 },
];

const ORDER_BY = { score: 'asc' as const };
const LIMIT = 3;

/** A normalized query with one member overridden. */
function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    where: partial.where ?? {},
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
    ...(partial.cursor === undefined ? {} : { cursor: partial.cursor }),
  };
}

/**
 * The data-source shape the harness seeds through and pages with. Only
 * `findPage` is asserted, but seeding runs through `create`; the five data
 * sources type these members differently, so a local structural alias keeps the
 * harness generic without widening to `IDataSource` (whose `findPage?` is
 * optional).
 */
interface IDataSourceLike {
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  findPage(
    query: NormalizedQuery,
  ): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }>;
}

describe('findPage keyset conformance — one page, every data source (§3.8)', () => {
  it('returns identical rows and mints an identical cursor across all five data sources', async () => {
    // Memory — the reference adapter.
    const memory = new MemoryAdapter();
    await memory.connect();
    const memorySource = memory.createDataSource('Widget') as unknown as IDataSourceLike;
    for (const row of SEED) await memorySource.create(row);

    // Prisma — in-memory fake store (the delegate is `client.user`).
    const prismaClient = createFakePrismaClient({ activeProvider: 'postgresql' });
    const prismaAdapter = new PrismaAdapter({ prismaClient });
    await prismaAdapter.connect();
    const prismaSource = prismaAdapter.createDataSource('User') as unknown as IDataSourceLike;
    for (const row of SEED) await prismaSource.create(row);

    // Drizzle — in-memory fake instance, extended with the `score` column the
    // keyset predicate orders by.
    const drizzleSource = createDrizzleDataSource(
      createFakeDrizzleInstance() as unknown as Parameters<typeof createDrizzleDataSource>[0],
      'Widget',
      {
        Widget: {
          ...createFakeDrizzleTable('Widget'),
          score: { name: 'score', table: 'Widget' },
        },
      },
      DRIZZLE_OPERATORS,
    ) as unknown as IDataSourceLike;
    for (const row of SEED) await drizzleSource.create(row);

    // Mongo — in-memory fake client.
    const mongoSource = createMongoDataSource(
      new FakeMongoClient(),
      'testdb',
      'Widget',
      undefined,
      fakeObjectIdCtor,
    ) as unknown as IDataSourceLike;
    for (const row of SEED) await mongoSource.create(row);

    // D1 — REAL SQLite engine.
    const d1Db = new SqliteD1(
      'CREATE TABLE Widget (id TEXT PRIMARY KEY, name TEXT, score INTEGER)',
    );
    const d1Source = createD1DataSource(d1Db, {
      table: 'Widget',
      primaryKey: ['id'],
    }) as unknown as IDataSourceLike;
    for (const row of SEED) await d1Source.create(row);

    const pages = await Promise.all([
      memorySource.findPage!(query({ orderBy: ORDER_BY, limit: LIMIT })),
      prismaSource.findPage!(query({ orderBy: ORDER_BY, limit: LIMIT })),
      drizzleSource.findPage!(query({ orderBy: ORDER_BY, limit: LIMIT })),
      mongoSource.findPage!(query({ orderBy: ORDER_BY, limit: LIMIT })),
      d1Source.findPage!(query({ orderBy: ORDER_BY, limit: LIMIT })),
    ]);

    const names = ['memory', 'prisma', 'drizzle', 'mongo', 'd1'] as const;
    const referenceRows = pages[0].rows.map((r) => r.id);
    const referenceCursor = pages[0].nextCursor;

    for (const [name, page] of names.map((n, i) => [n, pages[i]] as const)) {
      expect(page.rows.map((r) => r.id), `${name} rows`).toEqual(referenceRows);
      // The shared `mintNextCursor` produces a byte-identical token on every
      // adapter — the whole point of the helper move to `common`.
      expect(page.nextCursor, `${name} cursor`).toBe(referenceCursor);
      expect(referenceCursor, 'a cursor was minted').not.toBeNull();
    }
  });
});

/**
 * The Drizzle operators the adapter's `contains`/`in` arms build against. The
 * same shape the filter-conformance suite uses, kept local so this suite does
 * not reach into the other test file.
 */
const DRIZZLE_OPERATORS = {
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...exprs: unknown[]) => ({ op: 'and', exprs }),
  or: (...exprs: unknown[]) => ({ op: 'or', exprs }),
  gt: (col: unknown, val: unknown) => ({ op: 'gt', col, val }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  lte: (col: unknown, val: unknown) => ({ op: 'lte', col, val }),
  inArray: (col: unknown, values: readonly unknown[]) => ({ op: 'inArray', col, values }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: 'sql',
      text: [...strings],
      values,
    }),
    {
      raw: (text: string) => ({ op: 'raw', text }),
      param: (value: unknown) => ({ op: 'param', value }),
    },
  ),
  asc: (col: unknown) => ({ op: 'asc', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  count: () => ({ op: 'count' }),
};
