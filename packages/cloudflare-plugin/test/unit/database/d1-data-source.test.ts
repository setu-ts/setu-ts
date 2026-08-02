/**
 * The direct D1 data source, driven against a REAL SQLite engine.
 *
 * Every write is read back through a separate path (`SqliteD1.dump`) rather
 * than trusting the return value of the call under test — the M10 rule that a
 * no-op implementation passes its own tests when they only assert the no-op.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@hono-enterprise/common';

import { createD1DataSource } from '../../../src/database/d1-data-source.ts';
import { RecordingD1, SqliteD1 } from '../../d1-fakes.ts';

const SCHEMA = 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, age INTEGER, deletedAt TEXT)';
const TARGET = { table: 'users', primaryKey: 'id' } as const;

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
      /with id 'missing' not found/,
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
