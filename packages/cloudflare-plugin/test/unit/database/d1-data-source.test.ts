/**
 * The direct D1 data source, driven against a REAL SQLite engine.
 *
 * Every write is read back through a separate path (`SqliteD1.dump`) rather
 * than trusting the return value of the call under test — the M10 rule that a
 * no-op implementation passes its own tests when they only assert the no-op.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';
import { encodeCursor } from '@setu-ts/common';

import {
  createD1DataSource,
  createD1TransactionDataSource,
  D1TransactionBuffer,
} from '../../../src/database/d1-data-source.ts';
import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { RecordingD1, SqliteD1 } from '../../d1-fakes.ts';

const SCHEMA = 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, age INTEGER, deletedAt TEXT)';
const COMPOSITE_SCHEMA =
  'CREATE TABLE orders (tenantId TEXT, orderId TEXT, status TEXT, PRIMARY KEY (tenantId, orderId))';
const TARGET = { table: 'users', primaryKey: ['id'] } as const;
const COMPOSITE_TARGET = { table: 'orders', primaryKey: ['tenantId', 'orderId'] } as const;

function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return { where: {}, orderBy: {}, limit: -1, offset: 0, select: [], ...partial };
}

function seeded(): { db: SqliteD1; source: ReturnType<typeof createD1DataSource> } {
  const db = new SqliteD1(SCHEMA);
  const source = createD1DataSource(db, TARGET);
  return { db, source };
}

describe('createD1DataSource — writes', () => {
  it('creates a row and reads it back out of the database itself', async () => {
    const { db, source } = seeded();

    const created = await source.create({ id: 'u1', name: 'ada', age: 36 });

    expect(created).toEqual({ id: 'u1', name: 'ada', age: 36, deletedAt: null });
    // Read back through a path the code under test does not own.
    expect(db.dump('users')).toEqual([{ id: 'u1', name: 'ada', age: 36, deletedAt: null }]);
  });

  it('updates a row, returning and persisting the merged values', async () => {
    const { db, source } = seeded();
    await source.create({ id: 'u1', name: 'ada', age: 36 });

    const updated = await source.update('u1', { age: 37 });

    expect(updated).toEqual({ id: 'u1', name: 'ada', age: 37, deletedAt: null });
    expect(db.dump('users')[0]).toMatchObject({ age: 37, name: 'ada' });
  });

  it('throws when updating a row that does not exist', async () => {
    const { source } = seeded();
    await expect(source.update('missing', { age: 1 })).rejects.toThrow(
      /with id .*missing.* not found/,
    );
  });

  it('deletes a row, reports true, and removes it from the table', async () => {
    const { db, source } = seeded();
    await source.create({ id: 'u1', name: 'ada' });

    expect(await source.delete('u1')).toBe(true);
    expect(db.dump('users')).toEqual([]);
  });

  it('reports false when deleting a row that does not exist', async () => {
    const { source } = seeded();
    expect(await source.delete('missing')).toBe(false);
  });

  it('throws a diagnosable error when an insert returns no row', async () => {
    // A RETURNING insert yielding nothing means the write did not land; a
    // scripted binding is the only way to reach that branch deterministically.
    const db = new RecordingD1();
    db.returns([]);
    const source = createD1DataSource(db, TARGET);

    await expect(source.create({ id: 'u1' })).rejects.toThrow(/returned no row/);
  });
});

describe('createD1DataSource — reads', () => {
  async function withRows(): Promise<SqliteD1> {
    const db = new SqliteD1(SCHEMA);
    const source = createD1DataSource(db, TARGET);
    await source.create({ id: 'u1', name: 'ada', age: 36 });
    await source.create({ id: 'u2', name: 'bob', age: 24 });
    await source.create({ id: 'u3', name: 'cy', age: 51 });
    return db;
  }

  it('finds a row by primary key', async () => {
    const db = await withRows();
    const source = createD1DataSource(db, TARGET);
    expect(await source.findById('u2')).toMatchObject({ name: 'bob' });
  });

  it('returns null for a primary key with no row', async () => {
    const db = await withRows();
    const source = createD1DataSource(db, TARGET);
    expect(await source.findById('nope')).toBeNull();
  });

  it('finds all rows, filtered, sorted, paginated and projected', async () => {
    const db = await withRows();
    const source = createD1DataSource(db, TARGET);

    expect(await source.findAll(query({ orderBy: { age: 'asc' }, select: ['name'] }))).toEqual([
      { name: 'bob' },
      { name: 'ada' },
      { name: 'cy' },
    ]);
    expect(await source.findAll(query({ where: { name: 'ada' } }))).toHaveLength(1);
    expect(await source.findAll(query({ orderBy: { age: 'asc' }, limit: 1, offset: 1 })))
      .toMatchObject([{ name: 'ada' }]);
  });

  // The two statements below are asserted verbatim in `d1-sql.test.ts`, but a
  // string assertion cannot tell whether SQLite ACCEPTS them. Executing both
  // closes that gap: a malformed `LIMIT -1 OFFSET` or a `= ?` written where
  // `IS NULL` belongs would pass the string test and fail only in production.
  it('EXECUTES an offset with no limit (the LIMIT -1 form)', async () => {
    const db = await withRows();
    const source = createD1DataSource(db, TARGET);

    const rows = await source.findAll(query({ orderBy: { age: 'asc' }, offset: 1 }));

    expect(rows.map((r) => r.name)).toEqual(['ada', 'cy']);
  });

  it('EXECUTES a null filter as IS NULL, which `= ?` would never match', async () => {
    const db = await withRows();
    const source = createD1DataSource(db, TARGET);
    // `withRows` leaves deletedAt NULL on every row; mark one to prove the
    // filter discriminates rather than matching everything.
    await source.update('u2', { deletedAt: '2026-01-01' });

    const live = await source.findAll(query({ where: { deletedAt: null } }));

    expect(live.map((r) => r.name).sort()).toEqual(['ada', 'cy']);
    expect(await source.count({ deletedAt: null })).toBe(2);
  });

  // The portable expression is asserted as SQL text in `d1-sql.test.ts`. That
  // cannot tell whether SQLite accepts the statement or whether the source
  // forwards the filter at all — `findAll` and `count` reach the builder
  // through different call sites, and dropping either argument still compiles.
  it('EXECUTES a forwarded expression filter on both read paths', async () => {
    const db = await withRows();
    const source = createD1DataSource(db, TARGET);
    await source.update('u2', { deletedAt: '2026-01-01' });

    const filter = {
      type: 'or',
      filters: [
        { type: 'comparison', field: 'age', operator: 'gte', value: 50 },
        { type: 'comparison', field: 'deletedAt', operator: 'in', value: [null] },
      ],
    } as const;

    const rows = await source.findAll(query({ filter, orderBy: { id: 'asc' } }));

    expect(rows.map((r) => r.id)).toEqual(['u1', 'u3']);
    expect(await source.count({}, filter)).toBe(2);
    // Conjoined with the equality map rather than replacing it.
    expect(await source.count({ name: 'ada' }, filter)).toBe(1);
  });

  it('counts rows with and without a filter', async () => {
    const db = await withRows();
    const source = createD1DataSource(db, TARGET);

    expect(await source.count({})).toBe(3);
    expect(await source.count({ name: 'ada' })).toBe(1);
    expect(await source.count({ name: 'nobody' })).toBe(0);
  });

  it('coerces a non-numeric count and defaults an absent row to zero', async () => {
    const db = new RecordingD1();

    db.returns([{ count: '7' }]);
    expect(await createD1DataSource(db, TARGET).count({})).toBe(7);

    db.returns([]);
    expect(await createD1DataSource(db, TARGET).count({})).toBe(0);
  });
});

describe('createD1DataSource — composite keys', () => {
  async function seededCompositeDb(): Promise<SqliteD1> {
    const db = new SqliteD1(COMPOSITE_SCHEMA);
    const source = createD1DataSource(db, COMPOSITE_TARGET);
    await source.create({ tenantId: 't1', orderId: 'o1', status: 'open' });
    await source.create({ tenantId: 't1', orderId: 'o2', status: 'closed' });
    await source.create({ tenantId: 't2', orderId: 'o1', status: 'open' });
    return db;
  }

  it('finds a row by composite key', async () => {
    const db = await seededCompositeDb();
    const source = createD1DataSource(db, COMPOSITE_TARGET);
    const row = await source.findById({ tenantId: 't1', orderId: 'o2' });
    expect(row).toMatchObject({ status: 'closed' });
    expect(db.dump('orders')).toHaveLength(3);
  });

  it('returns null when a composite key has no row', async () => {
    const db = await seededCompositeDb();
    const source = createD1DataSource(db, COMPOSITE_TARGET);
    expect(await source.findById({ tenantId: 't9', orderId: 'o9' })).toBeNull();
  });

  it('updates a row through a composite key', async () => {
    const db = await seededCompositeDb();
    const source = createD1DataSource(db, COMPOSITE_TARGET);
    const updated = await source.update({ tenantId: 't1', orderId: 'o1' }, { status: 'shipped' });
    expect(updated).toMatchObject({ tenantId: 't1', orderId: 'o1', status: 'shipped' });
    expect(db.dump('orders')[0]).toMatchObject({ status: 'shipped' });
  });

  it('throws when updating a composite key that does not exist', async () => {
    const db = await seededCompositeDb();
    const source = createD1DataSource(db, COMPOSITE_TARGET);
    await expect(
      source.update({ tenantId: 't9', orderId: 'o9' }, { status: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('deletes a row through a composite key and reports true', async () => {
    const db = await seededCompositeDb();
    const source = createD1DataSource(db, COMPOSITE_TARGET);
    expect(await source.delete({ tenantId: 't1', orderId: 'o1' })).toBe(true);
    expect(db.dump('orders')).toHaveLength(2);
  });

  it('reports false when deleting a composite key that does not exist', async () => {
    const db = await seededCompositeDb();
    const source = createD1DataSource(db, COMPOSITE_TARGET);
    expect(await source.delete({ tenantId: 't9', orderId: 'o9' })).toBe(false);
  });

  it('refuses a composite key missing a required column', async () => {
    const db = await seededCompositeDb();
    const source = createD1DataSource(db, COMPOSITE_TARGET);
    await expect(source.findById({ tenantId: 't1' })).rejects.toThrow(
      CloudflareUnsupportedError,
    );
    await expect(source.findById({ tenantId: 't1' })).rejects.toThrow(
      /missing required column 'orderId'/,
    );
    await expect(
      source.update({ tenantId: 't1' }, { status: 'x' }),
    ).rejects.toThrow(CloudflareUnsupportedError);
    await expect(
      source.update({ tenantId: 't1' }, { status: 'x' }),
    ).rejects.toThrow(/missing required column 'orderId'/);
    await expect(source.delete({ tenantId: 't1' })).rejects.toThrow(CloudflareUnsupportedError);
    await expect(source.delete({ tenantId: 't1' })).rejects.toThrow(
      /missing required column 'orderId'/,
    );
  });
});

describe('createD1TransactionDataSource — composite keys on the deferred-write path', () => {
  async function seededForTx(): Promise<SqliteD1> {
    const db = new SqliteD1(COMPOSITE_SCHEMA);
    // Seed via the committed path so the transaction's read-first findById
    // sees committed state.
    const committed = createD1DataSource(db, COMPOSITE_TARGET);
    await committed.create({ tenantId: 't1', orderId: 'o1', status: 'open' });
    return db;
  }

  it('reads committed state, then buffers the update', async () => {
    const db = await seededForTx();
    const buffer = new D1TransactionBuffer();
    const source = createD1TransactionDataSource(db, COMPOSITE_TARGET, buffer);

    const updated = await source.update({ tenantId: 't1', orderId: 'o1' }, { status: 'shipped' });
    expect(updated).toMatchObject({ tenantId: 't1', orderId: 'o1', status: 'shipped' });
    // Not yet persisted — still in the buffer.
    expect(db.dump('orders')[0].status).toBe('open');
    // The buffer holds exactly one UPDATE statement.
    expect(buffer.drain()).toHaveLength(1);
    expect(buffer.drain()[0].sql).toContain('UPDATE "orders" SET "status" = ?1');
  });

  it('reads committed state, then buffers the delete', async () => {
    const db = await seededForTx();
    const buffer = new D1TransactionBuffer();
    const source = createD1TransactionDataSource(db, COMPOSITE_TARGET, buffer);

    expect(await source.delete({ tenantId: 't1', orderId: 'o1' })).toBe(true);
    // Not yet persisted — still in the buffer.
    expect(db.dump('orders')).toHaveLength(1);
    // The buffer holds exactly one DELETE statement.
    expect(buffer.drain()).toHaveLength(1);
    expect(buffer.drain()[0].sql).toContain('DELETE FROM "orders"');
  });

  it('refuses a composite key missing a required column inside a transaction', async () => {
    const db = await seededForTx();
    const buffer = new D1TransactionBuffer();
    const source = createD1TransactionDataSource(db, COMPOSITE_TARGET, buffer);

    await expect(source.findById({ tenantId: 't1' })).rejects.toThrow(CloudflareUnsupportedError);
    await expect(source.findById({ tenantId: 't1' })).rejects.toThrow(
      /missing required column 'orderId'/,
    );
    await expect(
      source.update({ tenantId: 't1' }, { status: 'x' }),
    ).rejects.toThrow(CloudflareUnsupportedError);
    await expect(
      source.update({ tenantId: 't1' }, { status: 'x' }),
    ).rejects.toThrow(/missing required column 'orderId'/);
    await expect(source.delete({ tenantId: 't1' })).rejects.toThrow(CloudflareUnsupportedError);
    await expect(source.delete({ tenantId: 't1' })).rejects.toThrow(
      /missing required column 'orderId'/,
    );
  });

  it('rolls back a buffered composite-key transaction', async () => {
    const db = await seededForTx();
    const buffer = new D1TransactionBuffer();
    const source = createD1TransactionDataSource(db, COMPOSITE_TARGET, buffer);

    await source.update({ tenantId: 't1', orderId: 'o1' }, { status: 'shipped' });
    await source.delete({ tenantId: 't1', orderId: 'o1' });

    // Rollback discards the buffer without executing anything.
    buffer.finalize();

    // Both operations were buffered but rolled back — nothing persisted.
    expect(db.dump('orders')[0]).toMatchObject({ status: 'open' });
  });
});

// ---------------------------------------------------------------------------
// findPage — the §3.8 keyset walk over real SQLite (P11 ties, §3.12 refusal).
//
// D1 cannot import database-plugin (§2.2), so the cursor payload, the keyset
// predicate, the sort fingerprint and the minting all come from the shared
// `@setu-ts/common` helpers — this suite proves D1's walk is byte-identical to
// the four database-plugin adapters' and cannot drift from it.
// ---------------------------------------------------------------------------

const PAGE_SCHEMA = 'CREATE TABLE widgets (id TEXT PRIMARY KEY, score INTEGER, name TEXT)';
const PAGE_TARGET = { table: 'widgets', primaryKey: ['id'] } as const;

/**
 * Seed six rows carrying only three distinct `score` values — two rows per
 * value — so a cursor walk that omits the key tiebreaker silently loses rows
 * (the P11 defect). Every adapter's walk must return all six exactly once.
 */
async function seedTiedFixture(): Promise<SqliteD1> {
  const db = new SqliteD1(PAGE_SCHEMA);
  const source = createD1DataSource(db, PAGE_TARGET);
  await source.create({ id: 'a', score: 10, name: 'alpha' });
  await source.create({ id: 'b', score: 10, name: 'bravo' });
  await source.create({ id: 'c', score: 20, name: 'charlie' });
  await source.create({ id: 'd', score: 20, name: 'delta' });
  await source.create({ id: 'e', score: 30, name: 'echo' });
  await source.create({ id: 'f', score: 30, name: 'foxtrot' });
  return db;
}

describe('createD1DataSource — findPage (§3.8 keyset pagination)', () => {
  it('walks a tied fixture across three pages, every row exactly once, last page null', async () => {
    const db = await seedTiedFixture();
    const source = createD1DataSource(db, PAGE_TARGET);

    const p1 = await source.findPage!(query({ orderBy: { score: 'asc' }, limit: 2 }));
    const p2 = await source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 2,
      cursor: p1.nextCursor as string,
    }));
    const p3 = await source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 2,
      cursor: p2.nextCursor as string,
    }));

    expect(p1.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(p2.rows.map((r) => r.id)).toEqual(['c', 'd']);
    // Six rows over three pages of two: the last page is a full page of two,
    // and the probe fetched exactly two (no extra), so nextCursor is null.
    expect(p3.rows.map((r) => r.id)).toEqual(['e', 'f']);
    expect(p3.nextCursor).toBeNull();

    const walked = [p1, p2, p3].flatMap((p) => p.rows.map((r) => r.id as string));
    expect(walked.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(walked.length).toBe(6);
    expect(new Set(walked).size).toBe(6);
  });

  it('reports nextCursor: null on the last page even when it is a full page', async () => {
    const db = await seedTiedFixture();
    const source = createD1DataSource(db, PAGE_TARGET);

    const p1 = await source.findPage!(query({ orderBy: { score: 'asc' }, limit: 3 }));
    const p2 = await source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 3,
      cursor: p1.nextCursor as string,
    }));

    expect(p1.rows).toHaveLength(3);
    expect(p1.nextCursor).not.toBeNull();
    expect(p2.rows).toHaveLength(3);
    expect(p2.nextCursor).toBeNull();
  });

  it('records the conjoined keyset filter, the limit+1 probe and the minted next cursor', async () => {
    const db = await seedTiedFixture();
    const source = createD1DataSource(db, PAGE_TARGET);

    // First page: mint a cursor from the returned last row.
    const p1 = await source.findPage!(query({ orderBy: { score: 'asc' }, limit: 2 }));
    expect(p1.rows).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();

    // Second page: assert on the statement the source actually sent.
    const p2 = await source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 2,
      cursor: p1.nextCursor as string,
    }));
    const last = db.executed.at(-1)!;
    // The conjoined keyset predicate is a FilterExpression rendered as the
    // lexicographic "row after this one" comparison:
    // (score > ?1 OR (score = ?2 AND id > ?3)).
    expect(last.sql).toContain('("score" > ?1 OR ("score" = ?2 AND "id" > ?3))');
    // The one-extra-row probe: limit + 1 reached the engine.
    expect(last.sql).toContain('LIMIT ?4');
    const limitParam = last.params[3];
    expect(limitParam).toBe(3);
    // The minted next cursor is encodeCursor's output for the last row's
    // ordered + key values under the current sort.
    expect(p2.nextCursor).toBe(
      encodeCursor({
        orderedValues: [20],
        keyValues: ['d'],
        sortFingerprint: 'score:asc',
      }),
    );
  });

  it('rejects a malformed cursor token by name (never a synchronous throw)', async () => {
    const db = await seedTiedFixture();
    const source = createD1DataSource(db, PAGE_TARGET);

    await expect(source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 2,
      cursor: '!!!notb64',
    }))).rejects.toThrow(CloudflareUnsupportedError);
    await expect(source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 2,
      cursor: '!!!notb64',
    }))).rejects.toThrow(/malformed cursor token/);
  });

  it('rejects a cursor whose fingerprint does not match the current sort by name', async () => {
    const db = await seedTiedFixture();
    const source = createD1DataSource(db, PAGE_TARGET);

    const mismatched = encodeCursor({
      orderedValues: [10],
      keyValues: ['a'],
      sortFingerprint: 'score:desc,id:asc',
    });
    await expect(source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 2,
      cursor: mismatched,
    }))).rejects.toThrow(CloudflareUnsupportedError);
    await expect(source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 2,
      cursor: mismatched,
    }))).rejects.toThrow(/cursor fingerprint mismatch/);
  });

  it('strips the key columns from the returned rows when a projection is present', async () => {
    const db = await seedTiedFixture();
    const source = createD1DataSource(db, PAGE_TARGET);

    const result = await source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 2,
      select: ['name'],
    }));

    // The caller's projection is what comes back — `id` (a key column) and
    // `score` (the ordered field) are stripped from the returned rows.
    expect(result.rows[0]).toEqual({ name: 'alpha' });
    expect(Object.hasOwn(result.rows[0], 'id')).toBe(false);
    expect(Object.hasOwn(result.rows[0], 'score')).toBe(false);
    // But the key column AND the ordered field reached the engine so the probe
    // and cursor minting could read them.
    const select = db.executed.at(-1)!.sql;
    expect(select).toContain('"name"');
    expect(select).toContain('"score"');
    expect(select).toContain('"id"');
  });

  it('refuses a query carrying both offset and cursor by name before any call', async () => {
    const db = await seedTiedFixture();
    const source = createD1DataSource(db, PAGE_TARGET);

    await expect(source.findPage!(query({
      orderBy: { score: 'asc' },
      limit: 2,
      offset: 1,
      cursor: encodeCursor({
        orderedValues: [10],
        keyValues: ['a'],
        sortFingerprint: 'score:asc,id:asc',
      }),
    }))).rejects.toThrow(/offset=1 conflicts with cursor/);
  });

  it('finds a page from the transaction data source, honoring committed state', async () => {
    const db = await seedTiedFixture();
    const committed = createD1DataSource(db, PAGE_TARGET);
    // Re-seed through the committed path so the transaction's read-first sees
    // committed state.
    await committed.create({ id: 'z', score: 5, name: 'zero' });
    const buffer = new D1TransactionBuffer();
    const txSource = createD1TransactionDataSource(db, PAGE_TARGET, buffer);

    const page = await txSource.findPage!(query({ orderBy: { score: 'asc' }, limit: 1 }));
    expect(page.rows.map((r) => r.id)).toEqual(['z']);
    expect(page.nextCursor).not.toBeNull();
    // The read ran against committed state, not the deferred buffer.
    expect(buffer.drain()).toHaveLength(0);
  });
});
