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
import {
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from 'npm:drizzle-orm@0.45.2/sqlite-core';
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
import { drizzle as mysqlDrizzle } from 'npm:drizzle-orm@0.45.2/mysql-proxy';
import { mysqlTable, text as mysqlText } from 'npm:drizzle-orm@0.45.2/mysql-core';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import {
  createDrizzleDataSource,
  DrizzleAdapter,
} from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createDrizzleDatabase } from '../../src/index.ts';
import type { DrizzleAdapterOptions } from '../../src/interfaces/index.ts';
import type { NormalizedQuery } from '@setu-ts/common';

const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
});

/** The composite-key table the M79 extension exercises on real SQLite. */
const enrollments = sqliteTable('enrollments', {
  tenantId: sqliteText('tenant_id').notNull(),
  userId: sqliteText('user_id').notNull(),
  course: sqliteText('course').notNull(),
});

/** The tied-fixture table the M79 keyset walk exercises on real SQLite. */
const events = sqliteTable('events', {
  id: sqliteText('id').primaryKey(),
  score: sqliteInteger('score').notNull(),
  run: sqliteText('run').notNull(),
});

/** The JSON-column table the M79 nested-path translation exercises. */
const jsonRows = sqliteTable('json_rows', {
  id: sqliteText('id').primaryKey(),
  profile: sqliteText('profile').notNull(),
  run: sqliteText('run').notNull(),
});

/** The Postgres mirror of {@linkcode jsonRows}, for the PG dialect's SQL. */
const pgJsonRows = pgTable('json_rows', {
  id: text('id').primaryKey(),
  profile: text('profile').notNull(),
  run: text('run').notNull(),
});

/** The MySQL mirror of {@linkcode jsonRows}, for the MySQL dialect's SQL. */
const mysqlJsonRows = mysqlTable('json_rows', {
  id: mysqlText('id').primaryKey(),
  profile: mysqlText('profile').notNull(),
  run: mysqlText('run').notNull(),
});

/**
 * Drizzle's REAL operator namespace, cast once.
 *
 * Drizzle's own operators take `SQLWrapper`, so they are not assignable to the
 * adapter's structural `(col: unknown, …)` signatures — the adapter casts them
 * the same way when it loads the namespace. Declared once so five call sites
 * cannot drift about which operators the adapter is given.
 */
const REAL_OPERATORS = {
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
} as unknown as Parameters<typeof createDrizzleDataSource>[3];

/** {@linkcode REAL_OPERATORS} with an explicit JSON dialect for a nested path. */
function operatorsFor(
  dialect: 'postgresql' | 'mysql' | 'sqlite' | undefined,
): Parameters<typeof createDrizzleDataSource>[3] {
  // `exactOptionalPropertyTypes`: an absent dialect is OMITTED, never assigned
  // `undefined` — which is also what an adapter that could not detect one does.
  return dialect === undefined
    ? { ...REAL_OPERATORS }
    : { ...REAL_OPERATORS, jsonDialect: dialect };
}

/** A per-run discriminator keeping this run's rows from any other's. */
const suffix = crypto.randomUUID().replaceAll('-', '');

/**
 * node:sqlite statement widened with `setReturnArrays`, which the runtime
 * exposes but the Node type snapshot does not yet declare (same shape as the
 * T14 integration suite's helper).
 */
interface ArrayReturningStatement {
  run(...params: SQLInputValue[]): unknown;
  all(...params: SQLInputValue[]): unknown[];
  setReturnArrays(returnArrays: boolean): void;
}

/**
 * Execute one Drizzle statement against the real engine, returning array rows
 * for every reading method — the shape the sqlite-proxy callback must answer.
 */
function executeSqlite(
  engine: DatabaseSync,
  statement: string,
  params: readonly unknown[],
  method: 'run' | 'all' | 'values' | 'get',
): Promise<{ rows: unknown[] }> {
  const prepared = engine.prepare(statement) as unknown as ArrayReturningStatement;
  if (method === 'run') {
    prepared.run(...(params as SQLInputValue[]));
    return Promise.resolve({ rows: [] });
  }
  prepared.setReturnArrays(true);
  const rows = prepared.all(...(params as SQLInputValue[]));
  return Promise.resolve({ rows });
}

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

describe('DrizzleAdapter with the real Drizzle SQL generator', () => {
  it('uses real columns for every repository operation', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[]; method: string }> = [];
    const database = drizzle((sql, params, method) => {
      calls.push({ sql, params, method });
      // A count query answers with one aggregate row; everything else is empty.
      return Promise.resolve({ rows: sql.includes('count(*)') ? [['4']] : [] });
    });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(
        database,
        (configured, work) => configured.transaction(work),
      ),
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
      drizzleInstance: createDrizzleDatabase(
        database,
        (configured, work) => configured.transaction(work),
      ),
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
      const rows = engine.prepare(statement).all(...(params as SQLInputValue[]));
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

  it('runs IDatabaseService.query() through the real PostgreSQL SQL generator', async () => {
    // X12-2: the adapter used to call `execute({ sql, params })`, a shape no
    // Drizzle driver accepts — every `query()` failed with `query.getSQL is
    // not a function`. The unit fake accepted any argument, so the method had
    // a green test and no working path. This drives the REAL generator, so the
    // statement text and the bound parameters are observed on the wire.
    const seen: Array<{ sql: string; params: readonly unknown[] }> = [];
    const database = drizzle((sql, params) => {
      seen.push({ sql, params });
      return Promise.resolve({ rows: [{ id: 'u1', name: 'Ada' }] });
    });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(
        database,
        (configured, work) => configured.transaction(work),
      ),
      drizzleTables: { User: users },
    });
    await adapter.connect();

    const rows = await adapter.rawQuery<{ id: string; name: string }>(
      'select id, name from users where role = $1 and name <> $2',
      ['admin', 'Bob'],
    );

    // The caller's placeholders survive verbatim, because Drizzle numbers its
    // `Param` chunks in encounter order and this statement is ascending.
    expect(seen[0]?.sql).toBe('select id, name from users where role = $1 and name <> $2');
    expect(seen[0]?.params).toEqual(['admin', 'Bob']);
    // Rows come back as OBJECTS, which is what `query<T>(): Promise<T[]>` promises.
    expect(rows).toEqual([{ id: 'u1', name: 'Ada' }]);
  });

  it('emits a parameter-free statement verbatim through the real generator', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(
        database,
        (configured, work) => configured.transaction(work),
      ),
      drizzleTables: { User: users },
    });
    await adapter.connect();

    await adapter.rawQuery('select count(*) from users -- a comment with a ?');
    expect(seen[0]).toBe('select count(*) from users -- a comment with a ?');
  });

  it('never lets a parameter value reach the statement text', async () => {
    const seen: Array<{ sql: string; params: readonly unknown[] }> = [];
    const database = drizzle((sql, params) => {
      seen.push({ sql, params });
      return Promise.resolve({ rows: [] });
    });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(
        database,
        (configured, work) => configured.transaction(work),
      ),
      drizzleTables: { User: users },
    });
    await adapter.connect();

    const hostile = "x'; drop table users; --";
    await adapter.rawQuery('select * from users where name = $1', [hostile]);
    expect(seen[0]?.sql).toBe('select * from users where name = $1');
    expect(seen[0]?.sql).not.toContain('drop table');
    expect(seen[0]?.params).toEqual([hostile]);
  });

  // ---------------------------------------------------------------------------
  // M79 — composite keys and the keyset predicate asserted in the emitted SQL
  // AND executed against the real node:sqlite engine (the M68 precedent: a
  // string assertion alone missed a live defect).
  // ---------------------------------------------------------------------------

  it('builds the composite-key WHERE and executes it on the real SQLite engine', async () => {
    const engine = new DatabaseSync(':memory:');
    engine.exec(
      'CREATE TABLE enrollments (' +
        'tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, course TEXT NOT NULL, ' +
        'PRIMARY KEY (tenant_id, user_id))',
    );
    engine.exec(
      `INSERT INTO enrollments VALUES ('acme', 'u1', 'algebra'), ('acme', 'u2', 'biology')`,
    );
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const database = sqliteDrizzle((statement, params, method) => {
      calls.push({ sql: statement, params });
      return executeSqlite(engine, statement, params, method);
    });
    const extra: Partial<DrizzleAdapterOptions> = {
      entities: { Enrollment: { primaryKey: ['tenantId', 'userId'] } },
    };
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(
        database,
        (configured, work) => configured.transaction(work),
      ),
      drizzleTables: { Enrollment: enrollments },
      ...extra,
    });
    await adapter.connect();
    const source = adapter.createDataSource('Enrollment');

    // The composite WHERE in the EMITTED SQL — both columns, mapping order…
    const found = await source.findById({ tenantId: 'acme', userId: 'u2' });
    expect(calls[0]?.sql).toContain('"enrollments"."tenant_id" = ?');
    expect(calls[0]?.sql).toContain('"enrollments"."user_id" = ?');
    expect(calls[0]?.params).toEqual(['acme', 'u2']);
    // …AND EXECUTED — the row the predicate addresses actually comes back,
    // which the string assertion alone cannot prove (M68).
    expect(found).toEqual({ tenantId: 'acme', userId: 'u2', course: 'biology' });

    // update returns the updated row; delete reports true — both executed.
    const updated = await source.update({ tenantId: 'acme', userId: 'u2' }, {
      course: 'chemistry',
    });
    expect(updated).toEqual({ tenantId: 'acme', userId: 'u2', course: 'chemistry' });
    expect(await source.delete({ tenantId: 'acme', userId: 'u1' })).toBe(true);
    expect(await source.findById({ tenantId: 'acme', userId: 'u1' })).toBeNull();
  });

  it('emits the keyset predicate and walks a tied fixture on the real SQLite engine', async () => {
    const engine = new DatabaseSync(':memory:');
    engine.exec(
      'CREATE TABLE events (id TEXT PRIMARY KEY, score INTEGER NOT NULL, run TEXT NOT NULL)',
    );
    const run = `w-${suffix}`;
    const scores = [30, 30, 30, 10, 10, 10];
    const ids = scores.map((_, i) => `r${i + 1}-${suffix}`);
    for (const [i, id] of ids.entries()) {
      engine.exec(`INSERT INTO events VALUES ('${id}', ${scores[i]}, '${run}')`);
    }
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const database = sqliteDrizzle((statement, params, method) => {
      calls.push({ sql: statement, params });
      return executeSqlite(engine, statement, params, method);
    });
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(
        database,
        (configured, work) => configured.transaction(work),
      ),
      drizzleTables: { Event: events },
    });
    await adapter.connect();
    const source = adapter.createDataSource('Event');

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (let page = 0; page < 10; page++) {
      const result = await source.findPage!(query({
        where: { run },
        orderBy: { score: 'desc' },
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      }));
      pages += 1;
      seen.push(...result.rows.map((row) => String(row.id)));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    // The executed walk: every row exactly once over three pages (P10/P11 —
    // six rows over two distinct scores, ties deliberate).
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(6);
    expect(pages).toBe(3);

    // The keyset predicate is IN the second page's EMITTED SQL: the
    // `or(lt(score), and(eq(score), gt(id)))` tree over the tiebreaker the
    // walk's correctness rests on.
    const keysetSql = calls[1]?.sql ?? '';
    expect(keysetSql).toContain('"events"."score" < ?');
    expect(keysetSql).toContain('"events"."score" = ?');
    expect(keysetSql).toContain('"events"."id" > ?');
    expect(keysetSql).toContain(' or (');
    // The caller's where is conjoined beside the predicate, and the bound
    // parameters carry the cursor row's values in predicate order.
    expect(keysetSql).toContain('"events"."run" = ?');
    expect(calls[1]?.params[0]).toBe(run);
    // The trailing 3 is the one-extra-row probe LIMIT — the SQLite dialect
    // binds `limit ?` where the PG dialect inlines it.
    expect(calls[1]?.params).toEqual([
      run,
      30,
      30,
      `r2-${suffix}`,
      3,
    ]);
  });
  it('translates a nested JSON path per dialect and executes it on real SQLite', async () => {
    // A JSON path below a real column reaches a different function on every
    // dialect, and getting one wrong returns WRONG ROWS rather than failing —
    // so all three are pinned as emitted SQL and one is executed for real.
    const engine = new DatabaseSync(':memory:');
    engine.exec(
      'CREATE TABLE json_rows (id TEXT PRIMARY KEY, profile TEXT NOT NULL, run TEXT NOT NULL)',
    );
    const run = `j-${suffix}`;
    const seed: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['a', { city: 'Kolkata', age: 30 }],
      ['b', { city: 'Delhi', age: 41 }],
      ['c', { city: '50% off', age: 9 }],
    ];
    for (const [id, profile] of seed) {
      engine
        .prepare('INSERT INTO json_rows VALUES (?, ?, ?)')
        .run(`${id}-${suffix}`, JSON.stringify(profile), run);
    }

    const sqliteCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const sqliteSource = createDrizzleDataSource(
      sqliteDrizzle((statement, params, method) => {
        sqliteCalls.push({ sql: statement, params });
        return executeSqlite(engine, statement, params, method);
      }) as unknown as Parameters<typeof createDrizzleDataSource>[0],
      'JsonRow',
      { JsonRow: jsonRows },
      operatorsFor('sqlite'),
    );

    const idsFor = async (
      filter: NonNullable<NormalizedQuery['filter']>,
    ): Promise<string[]> => {
      const rows = await sqliteSource.findAll(query({ where: { run }, filter }));
      return rows.map((row) => String(row.id).split('-')[0] as string).sort();
    };

    // Equality through the path.
    expect(
      await idsFor({
        type: 'comparison',
        field: ['profile', 'city'],
        operator: 'eq',
        value: 'Kolkata',
      }),
    ).toEqual(['a']);

    // `contains` escapes LIKE metacharacters, so a stored '50% off' is found
    // by its LITERAL text and a searched '%' matches nothing else.
    expect(
      await idsFor({
        type: 'comparison',
        field: ['profile', 'city'],
        operator: 'contains',
        value: '50%',
      }),
    ).toEqual(['c']);

    // The discriminating case: an ordered comparison against a NUMBER must
    // compare numerically. As text, '30' > '9' and '41' > '9' are both FALSE,
    // so a text comparison would answer with no rows at all.
    expect(
      await idsFor({
        type: 'comparison',
        field: ['profile', 'age'],
        operator: 'gt',
        value: 9,
      }),
    ).toEqual(['a', 'b']);
    expect(
      await idsFor({
        type: 'comparison',
        field: ['profile', 'age'],
        operator: 'gte',
        value: 41,
      }),
    ).toEqual(['b']);
    expect(
      await idsFor({
        type: 'comparison',
        field: ['profile', 'age'],
        operator: 'lt',
        value: 30,
      }),
    ).toEqual(['c']);

    // `in` has no JSON-path membership form, so it expands to an OR of
    // equality legs; an EMPTY list compiles to a match-nothing predicate.
    expect(
      await idsFor({
        type: 'comparison',
        field: ['profile', 'city'],
        operator: 'in',
        value: ['Kolkata', 'Delhi'],
      }),
    ).toEqual(['a', 'b']);
    expect(
      await idsFor({
        type: 'comparison',
        field: ['profile', 'city'],
        operator: 'in',
        value: [],
      }),
    ).toEqual([]);

    // SQLite extracts to TEXT for equality and leaves `json_extract` bare for
    // an ordered numeric comparison (its extraction preserves the JSON type).
    const sqliteSql = sqliteCalls.map((c) => c.sql).join('\n');
    expect(sqliteSql).toContain('CAST(json_extract("json_rows"."profile", ?) AS TEXT) = ?');
    expect(sqliteSql).toContain('json_extract("json_rows"."profile", ?) > ?');
    expect(sqliteSql).toContain("like ? escape '\\'");
    // The path travels as a BOUND parameter, never as statement text.
    expect(sqliteCalls[0]?.params).toContain('$.city');

    // Postgres: `#>>` against a text-array path, cast to numeric for an
    // ordered numeric comparison.
    const pgCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pgSource = createDrizzleDataSource(
      drizzle((statement, params) => {
        pgCalls.push({ sql: statement, params });
        return Promise.resolve({ rows: [] });
      }) as unknown as Parameters<typeof createDrizzleDataSource>[0],
      'JsonRow',
      { JsonRow: pgJsonRows },
      operatorsFor('postgresql'),
    );
    await pgSource.findAll(query({
      filter: {
        type: 'comparison',
        field: ['profile', 'city'],
        operator: 'eq',
        value: 'Kolkata',
      },
    }));
    await pgSource.findAll(query({
      filter: { type: 'comparison', field: ['profile', 'age'], operator: 'gt', value: 9 },
    }));
    expect(pgCalls[0]?.sql).toContain('("json_rows"."profile" #>> $1) = $2');
    expect(pgCalls[0]?.params).toContain('{city}');
    expect(pgCalls[1]?.sql).toContain('("json_rows"."profile" #>> $1)::numeric > $2');

    // MySQL: JSON_UNQUOTE(JSON_EXTRACT(...)), cast to DECIMAL for ordering.
    const mysqlCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const mysqlSource = createDrizzleDataSource(
      mysqlDrizzle((statement, params) => {
        mysqlCalls.push({ sql: statement, params });
        return Promise.resolve({ rows: [] });
      }) as unknown as Parameters<typeof createDrizzleDataSource>[0],
      'JsonRow',
      { JsonRow: mysqlJsonRows },
      operatorsFor('mysql'),
    );
    await mysqlSource.findAll(query({
      filter: {
        type: 'comparison',
        field: ['profile', 'city'],
        operator: 'eq',
        value: 'Kolkata',
      },
    }));
    await mysqlSource.findAll(query({
      filter: { type: 'comparison', field: ['profile', 'age'], operator: 'gt', value: 9 },
    }));
    expect(mysqlCalls[0]?.sql).toContain(
      'JSON_UNQUOTE(JSON_EXTRACT(`json_rows`.`profile`, ?)) = ?',
    );
    expect(mysqlCalls[1]?.sql).toContain('AS DECIMAL(65,30)) > ?');
  });

  it('refuses a nested path it cannot translate, by name', async () => {
    // A dialect that cannot be determined is refused rather than guessed at:
    // guessing emits syntax another engine reads differently and returns wrong
    // rows, where a refusal names the option that fixes it.
    const source = createDrizzleDataSource(
      sqliteDrizzle(() => Promise.resolve({ rows: [] })) as unknown as Parameters<
        typeof createDrizzleDataSource
      >[0],
      'JsonRow',
      { JsonRow: jsonRows },
      operatorsFor(undefined),
    );
    await expect(
      source.findAll(query({
        filter: {
          type: 'comparison',
          field: ['profile', 'city'],
          operator: 'eq',
          value: 'x',
        },
      })),
    ).rejects.toThrow(/could not be determined/);

    // A Date has no JSON representation, so it is refused rather than
    // compared as whatever text the writer happened to store.
    const dated = createDrizzleDataSource(
      sqliteDrizzle(() => Promise.resolve({ rows: [] })) as unknown as Parameters<
        typeof createDrizzleDataSource
      >[0],
      'JsonRow',
      { JsonRow: jsonRows },
      operatorsFor('sqlite'),
    );
    await expect(
      dated.findAll(query({
        filter: {
          type: 'comparison',
          field: ['profile', 'at'],
          operator: 'gt',
          value: new Date('2024-01-01T00:00:00Z'),
        },
      })),
    ).rejects.toThrow(/cannot compare a Date/);

    // A path segment carrying a path metacharacter is refused rather than
    // escaped — a wrong escape reads a DIFFERENT field instead of failing.
    await expect(
      dated.findAll(query({
        filter: {
          type: 'comparison',
          field: ['profile', 'city"]. $.other'],
          operator: 'eq',
          value: 'x',
        },
      })),
    ).rejects.toThrow(/not a plain JSON key/);
  });
});
