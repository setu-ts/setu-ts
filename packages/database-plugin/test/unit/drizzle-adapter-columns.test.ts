/**
 * Drizzle adapter — per-entity primaryKey override and composite-key support.
 *
 * T5 extends the X4-9 suite: an unconfigured entity still refuses a missing
 * `id` by name (the prior default path), while a composite-key table now
 * yields a working repository when `primaryKey` is configured — it previously
 * threw.
 *
 * T11 extends it with `findPage` — the §3.8 keyset pipeline exercised against
 * the REAL Drizzle SQL generator (pg-proxy). The keyset predicate is asserted
 * in the EMITTED SQL (the M68 precedent: a string assertion alone missed a
 * live defect), and the tied-fixture three-page walk (P11) proves the
 * primary-key tiebreaker is load-bearing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { drizzle } from 'npm:drizzle-orm@0.45.2/pg-proxy';
import { pgTable, primaryKey, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import type { DrizzleAdapterOptions } from '../../src/interfaces/index.ts';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createDrizzleDatabase } from '../../src/index.ts';
import { encodeCursor, keysetPredicate } from '@setu-ts/common';

const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

/** An `events` table carrying a `created_at` column for the keyset tests. */
const events = pgTable('events', {
  id: text('id').primaryKey(),
  created_at: text('created_at').notNull(),
  name: text('name').notNull(),
});

/** The shape X4-9 was reported against: `primary key (tenant_id, flag)`. */
const tenantFlags = pgTable('tenant_flags', {
  tenantId: text('tenant_id').notNull(),
  flag: text('flag').notNull(),
  value: text('value').notNull(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.flag] })]);

// ---------------------------------------------------------------------------
// A faithful in-memory evaluator over the REAL Drizzle SQL tree.
//
// The Drizzle query builder produces `SQL` objects carrying `queryChunks`;
// each comparison is `{ col, op, param }` and `and`/`or` are nested SQLs
// joined by a `" and "` / `" or "` StringChunk. This evaluator walks that
// exact structure so the adapter's `findPage` is driven by the real operator
// tree — not a hand-rolled copy — and the emitted SQL is the proof the
// predicate reached the driver (the M68 precedent).
// ---------------------------------------------------------------------------

type Chunk = { constructor?: { name?: string }; value?: unknown };

function chunkName(chunk: Chunk | undefined): string | undefined {
  return chunk?.constructor?.name;
}

function stringOf(chunk: Chunk | undefined): string | undefined {
  const value = chunk?.value;
  return Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : undefined;
}

function chunksOf(sql: unknown): Chunk[] {
  const chunks = (sql as { queryChunks?: ReadonlyArray<unknown> } | null | undefined)
    ?.queryChunks ?? [];
  return chunks as unknown as Chunk[];
}

function colName(sql: unknown): string | undefined {
  for (const chunk of chunksOf(sql)) {
    if (chunkName(chunk) === 'PgText') {
      // A PgText chunk carries the column name as a top-level `name`, not under
      // `value` (whose value is `undefined` here).
      return (chunk as { name?: string }).name;
    }
  }
  return undefined;
}

function opOf(sql: unknown): string | undefined {
  for (const chunk of chunksOf(sql)) {
    const value = stringOf(chunk);
    if (value !== undefined && /(<|>|=)/.test(value)) return value;
  }
  return undefined;
}

function paramOf(sql: unknown): unknown {
  for (const chunk of chunksOf(sql)) {
    if (chunkName(chunk) === 'Param') return chunk.value;
  }
  return undefined;
}

/**
 * Evaluate one Drizzle `SQL` predicate against a row, recursing through the
 * nested `and`/`or` tree.
 *
 * A comparison leaf carries a `PgText` column, an operator StringChunk, and a
 * `Param`. An `and`/`or` is a `SQL` whose chunks carry nested operand `SQL`s
 * joined by `" and "` / `" or "` StringChunks — the surrounding `(`/`)` are
 * paren-wrapping string chunks, not comparisons. The top-level predicate is
 * itself paren-wrapped (`("(" or-expr ")")`), so the and/or keyword can live
 * one level down: this evaluator collects every nested operand SQL in order
 * and joins them with the keyword seen between them, recursing into each.
 */
function evalSql(sql: unknown, row: Record<string, unknown>): boolean {
  const chunks = chunksOf(sql);

  // Comparison leaf: a column, an operator, and a parameter.
  const field = colName(sql);
  const op = opOf(sql);
  const value = paramOf(sql);
  if (field !== undefined && op !== undefined) {
    const actual = row[field];
    if (typeof actual === 'number' && typeof value === 'number') {
      if (op.includes('>')) return actual > value;
      if (op.includes('<')) return actual < value;
      return actual === value;
    }
    const as = String(actual);
    const bs = String(value);
    if (op.includes('>')) return as > bs;
    if (op.includes('<')) return as < bs;
    return as === bs;
  }

  // Compound: collect the nested operand SQLs and the joining keyword.
  const parts: unknown[] = [];
  let kind: 'and' | 'or' | null = null;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk) {
      parts.push(chunk);
    } else {
      const text = stringOf(chunk);
      if (text === ' and ' || text === ' or ') kind = text.trim() as 'and' | 'or';
    }
  }
  if (parts.length === 0) return true;
  if (parts.length === 1) return evalSql(parts[0], row);
  let result = evalSql(parts[0], row);
  for (let i = 1; i < parts.length; i++) {
    const part = evalSql(parts[i], row);
    result = kind === 'and' ? result && part : result || part;
  }
  return result;
}

/** The `order by` clause of a Drizzle query builder, read from its SQLs. */
type Order = { field: string; dir: 'asc' | 'desc' };

function orderOf(sql: unknown): Order {
  const field = colName(sql);
  let dir: 'asc' | 'desc' = 'asc';
  for (const chunk of chunksOf(sql)) {
    const value = stringOf(chunk);
    if (value !== undefined && value.includes('desc')) dir = 'desc';
  }
  return { field: field ?? '', dir };
}

/**
 * A faithful in-memory Drizzle instance: it evaluates `select().from()...`
 * over a seeded row set using the real operator tree, so the adapter's
 * `findPage` pipeline runs against the same SQL the real driver would.
 */
function makeEvaluator(rows: Record<string, unknown>[]) {
  // A FRESH builder per entry point, because a real Drizzle builder is a new
  // object per `select()`. The previous double kept `predicate`/`order`/`limit`
  // as shared closure state and never reset it, so a second query that omitted
  // `.where()` silently inherited the first query's predicate — a fixture that
  // reports a filter the adapter never asked for is the contract-violating
  // double this repository keeps tripping over.
  const makeQuery = () => {
    let predicate: unknown;
    let order: Order[] = [];
    let limit: number | undefined;
    const query = {
      where(expr: unknown) {
        predicate = expr;
        return query;
      },
      orderBy(...expressions: unknown[]) {
        order = expressions.map(orderOf);
        return query;
      },
      limit(value: number) {
        limit = value;
        return query;
      },
      then(onFulfilled: (rows: Record<string, unknown>[]) => unknown) {
        const out = rows.filter((row) => (predicate ? evalSql(predicate, row) : true));
        if (order.length > 0) {
          out.sort((a, b) => {
            for (const o of order) {
              const av = a[o.field] as number;
              const bv = b[o.field] as number;
              if (av === bv) continue;
              const cmp = av < bv ? -1 : av > bv ? 1 : 0;
              return o.dir === 'desc' ? -cmp : cmp;
            }
            return 0;
          });
        }
        const sliced = limit !== undefined ? out.slice(0, limit) : out;
        return Promise.resolve(sliced).then(() => onFulfilled(sliced));
      },
    };
    return query;
  };
  const instance = {
    select() {
      return {
        from() {
          return makeQuery();
        },
      };
    },
    insert() {
      return makeQuery();
    },
    update() {
      return makeQuery();
    },
    delete() {
      return makeQuery();
    },
    transaction: <T>(cb: (tx: unknown) => Promise<T>) => cb({}),
  };
  return instance;
}

/** Seed a table fixture keyed by the column name the real driver returns. */
function seed(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => ({ ...r }));
}

/** Build an adapter wired to an in-memory evaluator seeded with `rows`. */
function makeEvaluatorAdapter(
  rows: Record<string, unknown>[],
  extra?: Partial<DrizzleAdapterOptions>,
) {
  const instance = createDrizzleDatabase(
    makeEvaluator(seed(rows)),
    (instance, work) => instance.transaction(work),
  );
  const adapter = new DrizzleAdapter({
    drizzleInstance: instance,
    drizzleTables: { Event: events },
    ...extra,
  });
  return { adapter };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('DrizzleAdapter table registry', () => {
  it('connects with a composite-key table in the registry', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants, TenantFlag: tenantFlags },
    });
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
  });

  it('refuses a repository for the composite-key table by name when unconfigured', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants, TenantFlag: tenantFlags },
    });
    await adapter.connect();
    // Default primaryKey is ['id']; the composite object is handed to keyValues
    // which names the missing required column instead of columnFor throwing.
    await expect(adapter.createDataSource('TenantFlag').findById({ tenantId: 't1', flag: 'x' }))
      .rejects.toThrow(/missing required column 'id'/);
  });

  it('still serves a repository for the single-key table beside it', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants, TenantFlag: tenantFlags },
    });
    await adapter.connect();
    await adapter.createDataSource('Tenant').findById('t1');
    expect(seen[0]).toContain('"tenants"');
    expect(seen[0]).toContain('"id"');
  });

  it('still refuses a registry entry that is not a table definition', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants, Broken: 'not-a-table' },
    });
    await expect(adapter.connect()).rejects.toThrow(
      "Drizzle table 'Broken' must be a table definition",
    );
  });

  it('still refuses a null registry entry', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants, Broken: null },
    });
    await expect(adapter.connect()).rejects.toThrow(
      "Drizzle table 'Broken' must be a table definition",
    );
  });
});

describe('DrizzleAdapter per-entity primaryKey override', () => {
  it('configures key columns to replace the hardcoded id for a composite-key table', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const extra: Partial<DrizzleAdapterOptions> = {
      entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } },
    };
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants, TenantFlag: tenantFlags },
      ...extra,
    });
    await adapter.connect();
    const ds = adapter.createDataSource('TenantFlag');
    await ds.findById({ tenantId: 't1', flag: 'active' });
    // A multi-column WHERE is emitted: both columns appear.
    expect(seen[0]).toContain('"tenant_id"');
    expect(seen[0]).toContain('"flag"');
  });

  it('rejects a scalar against a composite-key target, by name and via Promise', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const extra: Partial<DrizzleAdapterOptions> = {
      entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } },
    };
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants, TenantFlag: tenantFlags },
      ...extra,
    });
    await adapter.connect();
    await expect(adapter.createDataSource('TenantFlag').findById('scalar-wrong'))
      .rejects.toThrow(/entity key must be a composite record for multi-column target/);
  });

  it('rejects a composite record missing a required column, by name and via Promise', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const extra: Partial<DrizzleAdapterOptions> = {
      entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } },
    };
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants, TenantFlag: tenantFlags },
      ...extra,
    });
    await adapter.connect();
    await expect(
      adapter.createDataSource('TenantFlag').findById({ tenantId: 't1' as unknown as string }),
    )
      .rejects.toThrow(/composite key is missing required column 'flag'/);
  });

  it('keeps the default ["id"] for an unconfigured entity', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants },
    });
    await adapter.connect();
    const ds = adapter.createDataSource('Tenant');
    await ds.findById('t1');
    expect(seen[0]).toContain('"tenants"');
    expect(seen[0]).toContain('"id"');
  });

  it('unconfigured entity still refuses a missing id by name', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Tenant: tenants, TenantFlag: tenantFlags },
    });
    await adapter.connect();
    await expect(adapter.createDataSource('TenantFlag').findById('t1'))
      .rejects.toThrow(
        "Drizzle table 'TenantFlag' has no 'id' column required by the database repository.",
      );
  });

  it('builds a compound WHERE for update using the configured key', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const extra: Partial<DrizzleAdapterOptions> = {
      entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } },
    };
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { TenantFlag: tenantFlags },
      ...extra,
    });
    await adapter.connect();
    const ds = adapter.createDataSource('TenantFlag');
    try {
      await ds.update({ tenantId: 't1', flag: 'active' }, { value: 'new' });
    } catch {
      // Expected: proxy returns [], so oneReturnedRow throws.
    }
    expect(seen[0]).toContain('and');
    expect(seen[0]).toContain('"tenant_id"');
    expect(seen[0]).toContain('"flag"');
  });

  it('builds a compound WHERE for delete using the configured key', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const extra: Partial<DrizzleAdapterOptions> = {
      entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } },
    };
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { TenantFlag: tenantFlags },
      ...extra,
    });
    await adapter.connect();
    const ds = adapter.createDataSource('TenantFlag');
    try {
      await ds.delete({ tenantId: 't1', flag: 'active' });
    } catch {
      // Expected: proxy returns [].
    }
    expect(seen[0]).toContain('"tenant_id"');
    expect(seen[0]).toContain('"flag"');
  });
});

// ---------------------------------------------------------------------------
// findPage — the §3.8 keyset pipeline, exercised against the real SQL generator
// ---------------------------------------------------------------------------

describe('DrizzleAdapter findPage — keyset predicate in emitted SQL', () => {
  it('emits the keyset predicate structure in the SQL text', async () => {
    const seen: string[] = [];
    const database = drizzle((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const configured = createDrizzleDatabase(
      database,
      (instance, work) => instance.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: configured,
      drizzleTables: { Event: events },
    });
    await adapter.connect();
    const ds = adapter.createDataSource('Event');
    expect(ds.findPage).toBeDefined();
    const findPage = ds.findPage!;
    // A cursor forces the keyset predicate through the existing predicateFor path.
    const token = encodeCursor({
      orderedValues: ['first'],
      keyValues: ['i1'],
      sortFingerprint: 'created_at:desc',
    });
    await findPage({
      where: {},
      orderBy: { created_at: 'desc' },
      limit: 10,
      offset: 0,
      select: [],
      cursor: token,
    });
    // The emitted SQL must carry the lexicographic "row after this" disjunction
    // exactly as keysetPredicate emits it: or(lt(created_at), and(eq(created_at),
    // gt(id))). A loose substring assertion alone missed a live defect in the
    // M68 precedent, so assert the distinctive signature and the tiebreaker.
    expect(seen[0]).toContain('"events"."created_at" <');
    expect(seen[0]).toContain(' or ');
    expect(seen[0]).toContain('"events"."created_at" =');
    expect(seen[0]).toContain(' and ');
    expect(seen[0]).toContain('"events"."id" >');
  });

  it('asserts the keyset predicate against keysetPredicate itself', () => {
    const predicate = keysetPredicate(
      ['first'],
      ['i1'],
      { created_at: 'desc' },
      ['id'],
    );
    // The predicate is the plan §3.8 tree: or(lt(created_at), and(eq(created_at), gt(id))).
    expect(predicate.type).toBe('or');
    if (predicate.type !== 'or') return;
    expect(predicate.filters.length).toBe(2);
  });
});

describe('DrizzleAdapter findPage — tied-fixture three-page walk (P11)', () => {
  const fixture = [
    { id: 'u1', created_at: 100 },
    { id: 'u2', created_at: 100 },
    { id: 'u3', created_at: 200 },
    { id: 'u4', created_at: 200 },
    { id: 'u5', created_at: 100 },
    { id: 'u6', created_at: 200 },
  ];

  it('returns every row exactly once across three pages', async () => {
    const { adapter } = makeEvaluatorAdapter(fixture);
    await adapter.connect();
    const ds = adapter.createDataSource('Event');
    expect(ds.findPage).toBeDefined();
    const findPage = ds.findPage!;
    const orderBy = { created_at: 'desc' as const };
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const pageResult = await findPage({
        where: {},
        orderBy,
        limit: 2,
        offset: 0,
        select: [],
        ...(cursor ? { cursor } : {}),
      });
      for (const row of pageResult.rows) collected.push(String(row.id));
      if (pageResult.nextCursor === null) break;
      cursor = pageResult.nextCursor;
    }
    // Every row exactly once — no repeat, none skipped (P11 tiebreaker load-bearing).
    expect(collected.length).toBe(6);
    expect(new Set(collected).size).toBe(6);
    expect(collected.sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  });

  it('reports nextCursor: null on the last page', async () => {
    const { adapter } = makeEvaluatorAdapter(fixture);
    await adapter.connect();
    const ds = adapter.createDataSource('Event');
    expect(ds.findPage).toBeDefined();
    const findPage = ds.findPage!;
    const orderBy = { created_at: 'desc' as const };
    let lastNextCursor: string | null = 'not-null';
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const pageResult = await findPage({
        where: {},
        orderBy,
        limit: 2,
        offset: 0,
        select: [],
        ...(cursor ? { cursor } : {}),
      });
      lastNextCursor = pageResult.nextCursor;
      if (pageResult.nextCursor === null) break;
      cursor = pageResult.nextCursor;
    }
    expect(lastNextCursor).toBeNull();
  });
});

describe('DrizzleAdapter findPage — rejections by name (never synchronous throw)', () => {
  it('rejects a malformed cursor token by name', async () => {
    const { adapter } = makeEvaluatorAdapter([{ id: 'u1', created_at: 100 }]);
    await adapter.connect();
    const ds = adapter.createDataSource('Event');
    expect(ds.findPage).toBeDefined();
    const findPage = ds.findPage!;
    await expect(
      findPage({
        where: {},
        orderBy: { created_at: 'desc' },
        limit: 10,
        offset: 0,
        select: [],
        cursor: 'not-a-valid-cursor!!!',
      }),
    ).rejects.toThrow(/malformed cursor token/);
  });

  it('rejects a fingerprint mismatch by name', async () => {
    const { adapter } = makeEvaluatorAdapter([{ id: 'u1', created_at: 100 }]);
    await adapter.connect();
    const ds = adapter.createDataSource('Event');
    expect(ds.findPage).toBeDefined();
    const findPage = ds.findPage!;
    // A cursor minted under a different sort fingerprint must be refused.
    const token = encodeCursor({
      orderedValues: ['first'],
      keyValues: ['i1'],
      sortFingerprint: 'name:asc',
    });
    await expect(
      findPage({
        where: {},
        orderBy: { created_at: 'desc' },
        limit: 10,
        offset: 0,
        select: [],
        cursor: token,
      }),
    ).rejects.toThrow(/fingerprint mismatch/);
  });

  it('rejects a cursor beside a non-zero offset by name', async () => {
    const { adapter } = makeEvaluatorAdapter([{ id: 'u1', created_at: 100 }]);
    await adapter.connect();
    const ds = adapter.createDataSource('Event');
    expect(ds.findPage).toBeDefined();
    const findPage = ds.findPage!;
    await expect(
      findPage({
        where: {},
        orderBy: { created_at: 'desc' },
        limit: 10,
        offset: 5,
        select: [],
        cursor: 'abc',
      }),
    ).rejects.toThrow(/offset.*conflicts with cursor/i);
  });
});

describe('DrizzleAdapter findPage — projection stripping', () => {
  it('returns only the caller-projected fields', async () => {
    const { adapter } = makeEvaluatorAdapter([
      { id: 'u1', created_at: 100, name: 'a' },
      { id: 'u2', created_at: 100, name: 'b' },
      { id: 'u3', created_at: 200, name: 'c' },
    ]);
    await adapter.connect();
    const ds = adapter.createDataSource('Event');
    expect(ds.findPage).toBeDefined();
    const findPage = ds.findPage!;
    const pageResult = await findPage({
      where: {},
      orderBy: { created_at: 'desc' },
      limit: 10,
      offset: 0,
      select: ['created_at'],
    });
    expect(pageResult.rows.length).toBe(3);
    for (const row of pageResult.rows) {
      expect(Object.keys(row).sort()).toEqual(['created_at']);
    }
  });
});
