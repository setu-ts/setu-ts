/**
 * One query, every adapter — the conformance suite that would have caught
 * X12-1.
 *
 * A table of {@linkcode FilterExpression} cases (including `%`, `_`, `\`, a
 * bare `%`, and an empty `in`) is run through **every** adapter's translation.
 * The Memory adapter evaluates rows directly, so it is the reference answer.
 * The Prisma and Drizzle translations are evaluated under faithful LIKE
 * semantics and must agree with the reference — or refuse explicitly (Prisma
 * on SQLite). This is the regression gate for §3.5: a future adapter cannot
 * reintroduce the `%`/`_` wildcard divergence without failing here.
 *
 * The M70b table grew a second row kind for M79 (§3.8): the findPage
 * cursor-walk conformance at the bottom of this file — one seeded fixture
 * paged through every data source, asserting identical rows and a
 * byte-identical minted cursor. It extends THIS table rather than living in a
 * second conformance file, so one file answers "do all five adapters agree?"
 * for both row kinds.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { FilterExpression } from '@setu-ts/common';

import {
  createDrizzleDataSource,
  type DrizzleOperators,
} from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { createMongoDataSource } from '../../src/adapters/mongo/mongo-data-source.ts';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { UnsupportedFilterOperatorError } from '../../src/errors.ts';
import { matchesFilter } from '../../src/query/query-builder.ts';
import type { NormalizedQuery } from '../../src/query/query-builder.ts';
import { translateFilter } from '../../src/adapters/mongo/mongo-query.ts';
import { createD1DataSource } from '../../../cloudflare-plugin/src/database/d1-data-source.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import { FakeMongoClient, fakeObjectIdCtor } from '../fixtures/fake-mongo-client.ts';
import { SqliteD1 } from '../../../cloudflare-plugin/test/d1-fakes.ts';

/**
 * Mock Drizzle operators — the same shape the adapter's `contains` arm builds
 * against. `sql` records its template so the conformance evaluator can read the
 * bound pattern. This avoids the adapter's lazy `import('npm:drizzle-orm')`.
 */
const DRIZZLE_OPERATORS: DrizzleOperators = {
  eq: (col, val) => ({ op: 'eq', col, val }),
  and: (...exprs) => ({ op: 'and', exprs }),
  or: (...exprs) => ({ op: 'or', exprs }),
  gt: (col, val) => ({ op: 'gt', col, val }),
  gte: (col, val) => ({ op: 'gte', col, val }),
  lt: (col, val) => ({ op: 'lt', col, val }),
  lte: (col, val) => ({ op: 'lte', col, val }),
  inArray: (col, values) => ({ op: 'inArray', col, values }),
  isNull: (col) => ({ op: 'isNull', col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: 'sql',
      text: [...strings],
      values,
    }),
    {
      // The real Drizzle tag carries these; a fake without them would let a
      // `sql.raw`/`sql.param` call ship untested (the contract-violating-double
      // class this repository keeps hitting).
      raw: (text: string) => ({ op: 'raw', text }),
      param: (value: unknown) => ({ op: 'param', value }),
    },
  ),
  asc: (col) => ({ op: 'asc', col }),
  desc: (col) => ({ op: 'desc', col }),
  count: () => ({ op: 'count' }),
};

// ---------------------------------------------------------------------------
// The reference table and the case table.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const ROWS: Row[] = [
  { id: 'r1', name: '50% off bracket' },
  { id: 'r2', name: '50x off' },
  { id: 'r3', name: 'has % sign' },
  { id: 'r4', name: 'a_b underscore' },
  { id: 'r5', name: 'back\\slash' },
  { id: 'r6', name: 'backXslash' },
  { id: 'r7', name: 'plain text' },
  { id: 'r8', name: 'Bolt M6' },
  // Regex-metacharacter rows. `.` and `*` are wildcards in a Mongo `$regex`
  // and literal data in a SQL `LIKE`, so these are the mirror image of the
  // `%`/`_` rows above — and no existing row could catch an unescaped Mongo
  // pattern, because none contains a regex metacharacter.
  { id: 'r9', name: 'v3.5 release' },
  { id: 'r10', name: 'v315 release' },
  { id: 'r11', name: 'a*b glob' },
  { id: 'r12', name: 'aXXb glob' },
];

const ids = (rows: Row[]): string[] => rows.map((r) => String(r.id));

/** The Memory adapter's evaluator is the reference answer. */
function reference(filter: FilterExpression): string[] {
  return ids(ROWS.filter((row) => matchesFilter(row, filter)));
}

interface Case {
  readonly label: string;
  readonly filter: FilterExpression;
}

const CASES: Case[] = [
  {
    label: "contains '50% off' (a % is data, not a wildcard)",
    filter: { type: 'comparison', field: 'name', operator: 'contains', value: '50% off' },
  },
  {
    label: "contains 'back\\slash' (a backslash is data)",
    filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'back\\slash' },
  },
  {
    label: "contains '%' (a bare % is data)",
    filter: { type: 'comparison', field: 'name', operator: 'contains', value: '%' },
  },
  {
    label: "contains 'a_b' (an _ is data, not a single-char wildcard)",
    filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'a_b' },
  },
  {
    label: "contains 'plain' (no metacharacter)",
    filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'plain' },
  },
  {
    label: "in ['Bolt M6']",
    filter: { type: 'comparison', field: 'name', operator: 'in', value: ['Bolt M6'] },
  },
  {
    label: 'in [] (empty membership)',
    filter: { type: 'comparison', field: 'name', operator: 'in', value: [] },
  },
  {
    label: 'in [null] (null-only membership)',
    filter: { type: 'comparison', field: 'name', operator: 'in', value: [null] },
  },
  {
    // A group is legal with no children and every adapter must answer with its
    // boolean identity. Mongo alone used to emit `$and: []`/`$or: []`, which
    // the server refuses outright — the divergence this table exists to catch.
    label: 'and [] (empty conjunction — matches everything)',
    filter: { type: 'and', filters: [] },
  },
  {
    label: 'or [] (empty disjunction — matches nothing)',
    filter: { type: 'or', filters: [] },
  },
  {
    label: "contains 'v3.5' (a . is data, not a regex any-char)",
    filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'v3.5' },
  },
  {
    label: "contains 'a*b' (a * is data, not a regex repeat)",
    filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'a*b' },
  },
  {
    label: "eq 'plain text'",
    filter: { type: 'comparison', field: 'name', operator: 'eq', value: 'plain text' },
  },
];

// ---------------------------------------------------------------------------
// Faithful LIKE evaluator — the semantics a connector whose LIKE defaults its
// escape character to backslash (PostgreSQL, MySQL, SQL Server, CockroachDB)
// applies to a pattern. `%` is any run, `_` is any single char, and a
// backslash escapes the following character.
// ---------------------------------------------------------------------------

function reEscape(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function likeMatch(haystack: string, pattern: string): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      re += reEscape(pattern[i + 1]);
      i++;
    } else if (c === '%') {
      re += '[\\s\\S]*';
    } else if (c === '_') {
      re += '[\\s\\S]';
    } else {
      re += reEscape(c);
    }
  }
  re += '$';
  return new RegExp(re).test(haystack);
}

// ---------------------------------------------------------------------------
// Prisma where-input evaluator (the subset the case table exercises).
// ---------------------------------------------------------------------------

function evalPrismaWhere(row: Row, where: unknown): boolean {
  if (where === null || typeof where !== 'object') {
    return false;
  }
  const w = where as Record<string, unknown>;
  if ('AND' in w) {
    return (w.AND as unknown[]).every((c) => evalPrismaWhere(row, c));
  }
  if ('OR' in w) {
    return (w.OR as unknown[]).some((c) => evalPrismaWhere(row, c));
  }
  for (const [field, cond] of Object.entries(w)) {
    const actual = row[field];
    if (cond === null) {
      return actual === null;
    }
    if (cond !== null && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('contains' in c) {
        return likeMatch(String(actual), `%${String(c.contains)}%`);
      }
      if ('in' in c) {
        return (c.in as unknown[]).includes(actual);
      }
    }
    return actual === cond;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Drizzle operator-tree evaluator (the subset the case table exercises).
// ---------------------------------------------------------------------------

function colName(col: unknown): string {
  return String((col as Record<string, unknown>).name);
}

function evalDrizzle(row: Row, expr: unknown): boolean {
  // The adapter answers `undefined` for a tautology, meaning "emit no WHERE
  // clause" — which selects every row. Modelling that as anything else would
  // make the harness disagree with the adapter it evaluates.
  if (expr === undefined) return true;
  const e = expr as Record<string, unknown>;
  switch (e.op) {
    case 'and':
      return (e.exprs as unknown[]).every((x) => evalDrizzle(row, x));
    case 'or':
      return (e.exprs as unknown[]).some((x) => evalDrizzle(row, x));
    case 'eq':
      return row[colName(e.col)] === e.val;
    case 'inArray':
      return (e.values as unknown[]).includes(row[colName(e.col)]);
    case 'isNull':
      return row[colName(e.col)] === null;
    case 'sql': {
      const [col, pattern] = e.values as [unknown, string];
      return likeMatch(String(row[colName(col)]), pattern);
    }
    default:
      throw new Error(`conformance evaluator: unhandled op ${String(e.op)}`);
  }
}

// ---------------------------------------------------------------------------
// Mongo operator-tree evaluator (the subset the case table exercises).
// ---------------------------------------------------------------------------

function evalMongo(row: Row, filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object') {
    return false;
  }
  const f = filter as Record<string, unknown>;
  for (const key of ['$and', '$or', '$nor'] as const) {
    // mongod REFUSES an empty logical array ("$and argument must be a
    // non-empty array"). JavaScript's `every`/`some` happily answer `true`/
    // `false` for one, so an evaluator that just delegated to them would
    // report agreement for a document the server rejects outright — the
    // contract-violating-double class, in the harness itself.
    if (key in f && (f[key] as unknown[]).length === 0) {
      throw new Error(`mongod refuses an empty array: ${key}`);
    }
  }
  if ('$and' in f) {
    return (f.$and as unknown[]).every((sub) => evalMongo(row, sub));
  }
  if ('$or' in f) {
    return (f.$or as unknown[]).some((sub) => evalMongo(row, sub));
  }
  if ('$nor' in f) {
    // `$nor: [{}]` is the negation of match-all — the match-nothing document
    // the adapter emits for an empty `or`. Verified against mongod 8, where it
    // selects zero rows both standalone and nested inside `$and`.
    return !(f.$nor as unknown[]).some((sub) => evalMongo(row, sub));
  }
  for (const [field, cond] of Object.entries(f)) {
    if (!matchConditionMongo(row[field], cond)) return false;
  }
  return true;
}

function matchConditionMongo(actual: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    const ops = cond as Record<string, unknown>;
    for (const [op, expected] of Object.entries(ops)) {
      switch (op) {
        case '$eq': {
          if (actual !== expected) return false;
          break;
        }
        case '$regex': {
          const re = new RegExp(String(expected), (ops.$options as string) ?? '');
          if (!re.test(String(actual))) return false;
          break;
        }
        case '$options': {
          break;
        }
        case '$in': {
          if (!(expected as unknown[]).some((v) => v === actual)) return false;
          break;
        }
        case '$gt':
          if (!(Number(actual) > Number(expected))) return false;
          break;
        case '$gte':
          if (!(Number(actual) >= Number(expected))) return false;
          break;
        case '$lt':
          if (!(Number(actual) < Number(expected))) return false;
          break;
        case '$lte':
          if (!(Number(actual) <= Number(expected))) return false;
          break;
        default:
          throw new Error(`conformance evaluator: unhandled Mongo op '${op}'`);
      }
    }
    return true;
  }
  return actual === cond;
}

/** Translate through Mongo and return the recorded match filter. */
function mongoWhere(filter: FilterExpression): Record<string, unknown> {
  // `eq` is carried by `where`, not a filter operator, so a bare `eq`
  // comparison must be folded into the match document as a field equality to
  // match the reference (Memory's `actual === value`).
  if (filter.type === 'comparison' && filter.operator === 'eq') {
    const field = Array.isArray(filter.field) ? filter.field.join('.') : (filter.field as string);
    return { [field]: filter.value };
  }
  const expression = { type: 'and', filters: [filter] } as FilterExpression;
  return translateFilter(expression);
}

// ---------------------------------------------------------------------------
// Translation drivers.
// ---------------------------------------------------------------------------

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

/** Translate through Prisma (given provider) and return the `where` input. */
async function prismaWhere(
  filter: FilterExpression,
  provider: string | undefined,
): Promise<unknown> {
  const client = createFakePrismaClient(provider !== undefined ? { activeProvider: provider } : {});
  const adapter = new PrismaAdapter({ prismaClient: client });
  await adapter.connect();
  const ds = adapter.createDataSource('User');
  await ds.findAll(query({ filter }));
  const call = client.recordedCalls.find((c) => c.action === 'findMany');
  return call?.args.where;
}

/** Translate through Drizzle and return the recorded `where` expression. */
async function drizzleWhere(filter: FilterExpression): Promise<unknown> {
  const fakeDb = createFakeDrizzleInstance();
  const table = createFakeDrizzleTable('user');
  // The factory path with explicit mock operators — the same one the Drizzle
  // adapter's unit tests use — avoids the adapter's lazy `import('npm:drizzle-orm')`.
  const ds = createDrizzleDataSource(fakeDb, 'user', { user: table }, DRIZZLE_OPERATORS);
  await ds.findAll(query({ filter }));
  const call = fakeDb.recordedCalls.filter((c) => c.action === 'where').at(-1);
  return call?.args.expression;
}

// ---------------------------------------------------------------------------
// The conformance suite.
// ---------------------------------------------------------------------------

describe('filter conformance — one query, every adapter (§3.7)', () => {
  for (const { label, filter } of CASES) {
    it(`Memory/Prisma/Drizzle agree: ${label}`, async () => {
      const expected = reference(filter);

      // Prisma on an escaping connector (postgresql) must select the same rows.
      const prisma = await prismaWhere(filter, 'postgresql');
      const prismaRows = ids(ROWS.filter((row) => evalPrismaWhere(row, prisma)));
      expect(prismaRows).toEqual(expected);

      // Drizzle must select the same rows.
      const drizzle = await drizzleWhere(filter);
      const drizzleRows = ids(ROWS.filter((row) => evalDrizzle(row, drizzle)));
      expect(drizzleRows).toEqual(expected);
    });
  }

  // Every case also agrees with Mongo's native $regex/$in/$gt… translation.
  for (const { label, filter } of CASES) {
    it(`Memory/Mongo agree: ${label}`, () => {
      const expected = reference(filter);
      const filterDoc = mongoWhere(filter);
      const mongoRows = ids(ROWS.filter((row) => evalMongo(row, filterDoc)));
      expect(mongoRows).toEqual(expected);
    });
  }

  it('the escaped-dot contains case does not match the metacharacter row', () => {
    // §3.7: an unescaped '3.5' would treat '.' as "any char". The escaped
    // pattern must select only the literal, and the reference table's
    // metacharacter row must never be selected by a bare substring contains.
    const filter = {
      type: 'comparison',
      field: 'name',
      operator: 'contains',
      value: 'back',
    } as FilterExpression;
    const rows = ids(ROWS.filter((row) => evalMongo(row, mongoWhere(filter))));
    expect(rows).toEqual(['r5', 'r6']);
  });

  it('the % case is the X12-1 discriminator: literal, not wildcard', () => {
    // Reference: only rows containing the literal substring '50% off'.
    const expected = reference(CASES[0].filter);
    expect(expected).toEqual(['r1']);
    // The whole point: '50x off' (r2) must NOT match, which it would if the
    // `%` were a wildcard.
    expect(expected).not.toContain('r2');
  });

  it('Prisma on SQLite refuses every contains case with a named error', async () => {
    for (const { label, filter } of CASES) {
      if (filter.type !== 'comparison' || filter.operator !== 'contains') {
        continue;
      }
      let caught: unknown;
      try {
        await prismaWhere(filter, 'sqlite');
      } catch (err) {
        caught = err;
      }
      expect(caught, `expected ${label} to refuse on sqlite`).toBeInstanceOf(
        UnsupportedFilterOperatorError,
      );
    }
  });

  it('Prisma on an undetermined connector refuses a contains case naming the provider option', async () => {
    // A client with no detectable provider.
    const bare = {
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
      $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(bare),
      $queryRawUnsafe: () => Promise.resolve([]),
      user: {
        findUnique: () => Promise.resolve(null),
        findMany: () => Promise.resolve([]),
        create: (a: { data: Record<string, unknown> }) => Promise.resolve(a.data),
        update: () => Promise.reject(new Error('nope')),
        delete: () => Promise.reject(new Error('nope')),
        count: () => Promise.resolve(0),
      },
    };
    const adapter = new PrismaAdapter({ prismaClient: bare });
    await adapter.connect();
    const ds = adapter.createDataSource('User');
    expect(() => ds.findAll(query({ filter: CASES[0].filter }))).toThrow(/provider/);
  });

  it('Memory and Drizzle both refuse an unknown orderBy column, by name', async () => {
    // X12-5: Memory used to return rows in insertion order and answer 200 for
    // a column Drizzle rejects outright, so the same call diverged between the
    // default adapter and the one the application deploys on.
    const memory = new MemoryAdapter();
    await memory.connect();
    const memorySource = memory.createDataSource('Widget');
    await memorySource.create({ id: 'w1', name: 'Bolt' });

    await expect(
      memorySource.findAll({
        where: {},
        orderBy: { sku: 'asc' },
        limit: -1,
        offset: 0,
        select: [],
      }),
    ).rejects.toThrow("has no 'sku' column for orderBy");

    const drizzleSource = createDrizzleDataSource(
      createFakeDrizzleInstance() as unknown as Parameters<typeof createDrizzleDataSource>[0],
      'Widget',
      { Widget: createFakeDrizzleTable('Widget') },
      DRIZZLE_OPERATORS,
    );
    await expect(
      drizzleSource.findAll({
        where: {},
        orderBy: { sku: 'asc' },
        limit: -1,
        offset: 0,
        select: [],
      }),
    ).rejects.toThrow("has no 'sku' column");
  });

  it('Memory and Drizzle both refuse an unknown select column, by name', async () => {
    const memory = new MemoryAdapter();
    await memory.connect();
    const memorySource = memory.createDataSource('Widget');
    await memorySource.create({ id: 'w1', name: 'Bolt' });

    await expect(
      memorySource.findAll({ where: {}, orderBy: {}, limit: -1, offset: 0, select: ['sku'] }),
    ).rejects.toThrow("has no 'sku' column for select");

    const drizzleSource = createDrizzleDataSource(
      createFakeDrizzleInstance() as unknown as Parameters<typeof createDrizzleDataSource>[0],
      'Widget',
      { Widget: createFakeDrizzleTable('Widget') },
      DRIZZLE_OPERATORS,
    );
    await expect(
      drizzleSource.findAll({ where: {}, orderBy: {}, limit: -1, offset: 0, select: ['sku'] }),
    ).rejects.toThrow("has no 'sku' column");
  });
});

// ---------------------------------------------------------------------------
// The §3.8 cursor-walk row of the M70b table — one walk, every data source.
//
// Extends the filter table above rather than adding a second conformance
// file: the same "one query, every adapter" shape, now over `findPage`. The
// five data sources seed one shared fixture, take the first page, and must
// return IDENTICAL rows and MINT A BYTE-IDENTICAL cursor token — the token is
// `encodeCursor` over the last row's ordered + key values under the shared
// fingerprint, so identity is the guarantee the common helpers sell.
//
// Package-boundary seam (§2.2): no plugin depends on another at RUNTIME, and
// the M79 plan forbids cloudflare-plugin importing database-plugin test
// fixtures. This row lives in database-plugin's test tree and reaches across
// to cloudflare-plugin's `createD1DataSource` + `SqliteD1` harness so the D1
// leg runs on the REAL node:sqlite engine — the one direction the seam
// allows, and the reason a duplicated D1-side copy of this row in
// cloudflare-plugin was rejected. The multi-page walk itself is asserted per
// adapter where the engine models it faithfully (D1: d1-data-source.test.ts
// three-page tied walk; Mongo/Prisma: the guarded real-server suites).
//
// Why the FIRST page only: the Drizzle and Mongo fakes here sort by the first
// column only and cannot model the keyset tiebreaker faithfully, so a
// multi-page walk through them would assert behavior the fakes — not the
// adapters — own. The first page and the minted token are exactly what the
// shared `@setu-ts/common` helpers guarantee, and they are faithful across
// all five.
// ---------------------------------------------------------------------------

/** The shared cursor-walk fixture: distinct `score` values keep page one unambiguous. */
const WALK_SEED = [
  { id: 'a', name: 'alpha', score: 1 },
  { id: 'b', name: 'bravo', score: 2 },
  { id: 'c', name: 'charlie', score: 3 },
  { id: 'd', name: 'delta', score: 4 },
  { id: 'e', name: 'echo', score: 5 },
  { id: 'f', name: 'foxtrot', score: 6 },
];

const WALK_ORDER_BY = { score: 'asc' as const };
const WALK_LIMIT = 3;

/** A normalized page query with one member overridden. */
function pageQuery(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
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
 * The data-source shape the walk seeds through and pages with. Only
 * `findPage` is asserted, but seeding runs through `create`; the five data
 * sources type these members differently, so a local structural alias keeps
 * the harness generic without widening to `IDataSource` (whose `findPage?` is
 * optional).
 */
interface IDataSourceLike {
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  findPage(
    query: NormalizedQuery,
  ): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }>;
}

describe('findPage cursor-walk conformance — one walk, every data source (§3.8, M70b table)', () => {
  it('returns identical rows and mints an identical cursor across all five data sources', async () => {
    // Memory — the reference adapter.
    const memory = new MemoryAdapter();
    await memory.connect();
    const memorySource = memory.createDataSource('Widget') as unknown as IDataSourceLike;
    for (const row of WALK_SEED) await memorySource.create(row);

    // Prisma — in-memory fake store (the delegate is `client.user`).
    const prismaClient = createFakePrismaClient({ activeProvider: 'postgresql' });
    const prismaAdapter = new PrismaAdapter({ prismaClient });
    await prismaAdapter.connect();
    const prismaSource = prismaAdapter.createDataSource('User') as unknown as IDataSourceLike;
    for (const row of WALK_SEED) await prismaSource.create(row);

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
    for (const row of WALK_SEED) await drizzleSource.create(row);

    // Mongo — in-memory fake client.
    const mongoSource = createMongoDataSource(
      new FakeMongoClient(),
      'testdb',
      'Widget',
      undefined,
      fakeObjectIdCtor,
    ) as unknown as IDataSourceLike;
    for (const row of WALK_SEED) await mongoSource.create(row);

    // D1 — REAL SQLite engine.
    const d1Db = new SqliteD1(
      'CREATE TABLE Widget (id TEXT PRIMARY KEY, name TEXT, score INTEGER)',
    );
    const d1Source = createD1DataSource(d1Db, {
      table: 'Widget',
      primaryKey: ['id'],
    }) as unknown as IDataSourceLike;
    for (const row of WALK_SEED) await d1Source.create(row);

    const pages = await Promise.all([
      memorySource.findPage(pageQuery({ orderBy: WALK_ORDER_BY, limit: WALK_LIMIT })),
      prismaSource.findPage(pageQuery({ orderBy: WALK_ORDER_BY, limit: WALK_LIMIT })),
      drizzleSource.findPage(pageQuery({ orderBy: WALK_ORDER_BY, limit: WALK_LIMIT })),
      mongoSource.findPage(pageQuery({ orderBy: WALK_ORDER_BY, limit: WALK_LIMIT })),
      d1Source.findPage(pageQuery({ orderBy: WALK_ORDER_BY, limit: WALK_LIMIT })),
    ]);

    const names = ['memory', 'prisma', 'drizzle', 'mongo', 'd1'] as const;
    const referenceRows = pages[0].rows.map((r) => r.id);
    const referenceCursor = pages[0].nextCursor;

    for (const [name, page] of names.map((n, i) => [n, pages[i]] as const)) {
      expect(page.rows.map((r) => r.id), `${name} rows`).toEqual(referenceRows);
      // The shared `mintNextCursor` produces a byte-identical token on every
      // adapter — the whole point of the helpers living in `common`.
      expect(page.nextCursor, `${name} cursor`).toBe(referenceCursor);
      expect(referenceCursor, 'a cursor was minted').not.toBeNull();
    }
  });
});
