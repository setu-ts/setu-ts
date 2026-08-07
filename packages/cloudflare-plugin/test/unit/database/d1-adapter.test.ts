/**
 * `D1Adapter` lifecycle, entity mapping, and raw queries.
 *
 * The transaction surface has its own file (`d1-transaction.test.ts`).
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDatabaseAdapter } from '@setu-ts/common';

import {
  CloudflareBindingMissingError,
  CloudflareUnsupportedError,
  D1Adapter,
  type ID1Database,
  isD1Database,
} from '../../../src/index.ts';
import { SqliteD1 } from '../../d1-fakes.ts';

const SCHEMA = 'CREATE TABLE users (user_id TEXT PRIMARY KEY, name TEXT)';

describe('D1Adapter — binding validation', () => {
  // Without the constructor guard every case below registers cleanly, reports
  // `up` from the `database` health indicator, and fails the FIRST query with
  // `TypeError: Cannot read properties of undefined (reading 'prepare')`.
  it('refuses an absent binding, naming what to fix', () => {
    const absent = undefined as unknown as ID1Database;

    expect(() => new D1Adapter(absent)).toThrow(CloudflareBindingMissingError);
    expect(() => new D1Adapter(absent)).toThrow(/received `undefined`/);
    expect(() => new D1Adapter(absent)).toThrow(/d1_databases/);
  });

  it('refuses a null binding', () => {
    expect(() => new D1Adapter(null as unknown as ID1Database)).toThrow(
      CloudflareBindingMissingError,
    );
  });

  it('refuses a binding of the wrong shape, naming the missing methods', () => {
    // A mistyped name pointing at a KV namespace rather than a D1 database.
    const kvShaped = { get() {}, put() {}, delete() {}, list() {} } as unknown as ID1Database;

    expect(() => new D1Adapter(kvShaped)).toThrow(CloudflareBindingMissingError);
    expect(() => new D1Adapter(kvShaped)).toThrow(/missing prepare and batch/);
  });

  it('refuses a partially-shaped binding, naming only the method that is absent', () => {
    const noBatch = { prepare() {} } as unknown as ID1Database;
    expect(() => new D1Adapter(noBatch)).toThrow(/missing batch/);
  });

  it('refuses a primitive', () => {
    expect(() => new D1Adapter('DB' as unknown as ID1Database)).toThrow(/a string/);
  });

  it('accepts a real D1-shaped binding', () => {
    expect(() => new D1Adapter(new SqliteD1(SCHEMA))).not.toThrow();
  });
});

describe('isD1Database', () => {
  it('accepts a D1-shaped binding and rejects everything else', () => {
    expect(isD1Database(new SqliteD1(SCHEMA))).toBe(true);
    expect(isD1Database({ prepare() {}, batch() {} })).toBe(true);
    expect(isD1Database({ prepare() {} })).toBe(false);
    expect(isD1Database({ get() {}, put() {} })).toBe(false);
    expect(isD1Database(undefined)).toBe(false);
    expect(isD1Database(null)).toBe(false);
    expect(isD1Database('DB')).toBe(false);
  });
});

describe('D1Adapter — lifecycle', () => {
  it('is not ready until connect(), and not ready again after disconnect()', async () => {
    const adapter = new D1Adapter(new SqliteD1(SCHEMA));

    expect(adapter.isReady()).toBe(false);
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
  });

  it('refuses data access before connect()', async () => {
    const adapter = new D1Adapter(new SqliteD1(SCHEMA));

    expect(() => adapter.createDataSource('users')).toThrow(CloudflareUnsupportedError);
    expect(() => adapter.createDataSource('users')).toThrow(/call connect\(\) first/);
    await expect(adapter.rawQuery('SELECT 1')).rejects.toThrow(CloudflareUnsupportedError);
    await expect(adapter.beginTransaction()).rejects.toThrow(CloudflareUnsupportedError);
  });

  it('refuses data access after disconnect(), so a closed app stops serving', async () => {
    const adapter = new D1Adapter(new SqliteD1(SCHEMA));
    await adapter.connect();
    await adapter.disconnect();

    expect(() => adapter.createDataSource('users')).toThrow(CloudflareUnsupportedError);
    await expect(adapter.rawQuery('SELECT 1')).rejects.toThrow(CloudflareUnsupportedError);
  });
});

describe('D1Adapter — entity mapping', () => {
  it('maps an entity onto a configured table and primary key', async () => {
    const db = new SqliteD1(SCHEMA);
    const adapter = new D1Adapter(db, {
      tables: { User: { table: 'users', primaryKey: 'user_id' } },
    });
    await adapter.connect();

    const source = adapter.createDataSource('User');
    await source.create({ user_id: 'u1', name: 'ada' });

    expect(await source.findById('u1')).toMatchObject({ name: 'ada' });
    expect(db.executed[0].sql).toContain('INSERT INTO "users"');
    expect(db.executed[1].sql).toContain('WHERE "user_id" = ?1');
  });

  it('falls back to the entity name and "id" when the entity is unmapped', async () => {
    const db = new SqliteD1('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)');
    const adapter = new D1Adapter(db, { tables: { User: { table: 'users' } } });
    await adapter.connect();

    await adapter.createDataSource('notes').create({ id: 'n1', body: 'hi' });

    expect(db.executed[0].sql).toContain('INSERT INTO "notes"');
    expect(db.dump('notes')).toEqual([{ id: 'n1', body: 'hi' }]);
  });

  it('honors a partial mapping, defaulting the field that was omitted', async () => {
    const db = new SqliteD1('CREATE TABLE people (id TEXT PRIMARY KEY)');
    // `table` given, `primaryKey` omitted → defaults to 'id'.
    const adapter = new D1Adapter(db, { tables: { Person: { table: 'people' } } });
    await adapter.connect();

    await adapter.createDataSource('Person').findById('p1');
    expect(db.executed[0].sql).toBe('SELECT * FROM "people" WHERE "id" = ?1 LIMIT 1');
  });

  it('works with no options at all', async () => {
    const db = new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY)');
    const adapter = new D1Adapter(db);
    await adapter.connect();

    expect(await adapter.createDataSource('users').count({})).toBe(0);
  });
});

describe('D1Adapter — rawQuery', () => {
  it('binds parameters positionally and returns the rows', async () => {
    const db = new SqliteD1(SCHEMA);
    const adapter = new D1Adapter(db);
    await adapter.connect();
    await adapter.rawQuery('INSERT INTO users (user_id, name) VALUES (?1, ?2)', ['u1', 'ada']);

    const rows = await adapter.rawQuery<{ name: string }>(
      'SELECT name FROM users WHERE user_id = ?1',
      ['u1'],
    );

    expect(rows).toEqual([{ name: 'ada' }]);
  });

  it('accepts a query with no parameters', async () => {
    const adapter = new D1Adapter(new SqliteD1(SCHEMA));
    await adapter.connect();

    expect(await adapter.rawQuery('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });
});

describe('D1Adapter — the promoted port', () => {
  it('satisfies IDatabaseAdapter with no cast', () => {
    // The whole point of the M52c promotion: a backend in another package can
    // be typed against the committed port. If this needed a cast, the
    // promotion would not have achieved anything.
    const adapter: IDatabaseAdapter = new D1Adapter(new SqliteD1(SCHEMA));
    expect(typeof adapter.createDataSource).toBe('function');
    expect(typeof adapter.rawQuery).toBe('function');
    expect(typeof adapter.beginTransaction).toBe('function');
  });
});
