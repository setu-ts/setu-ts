/**
 * D1's deferred-batch transaction.
 *
 * D1 has no interactive transaction, so writes are buffered and flushed as one
 * `batch()`. Every consequence of that design is asserted here rather than
 * left to be discovered: the single batch, the silent rollback, the absence of
 * read-your-own-writes, and the refusal to insert without a key.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CloudflareUnsupportedError, D1Adapter } from '../../../src/index.ts';
import { SqliteD1 } from '../../d1-fakes.ts';

const SCHEMA = 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, age INTEGER)';

async function connected(): Promise<{ db: SqliteD1; adapter: D1Adapter }> {
  const db = new SqliteD1(SCHEMA);
  const adapter = new D1Adapter(db);
  await adapter.connect();
  return { db, adapter };
}

describe('D1Adapter transactions — commit', () => {
  it('flushes every buffered write as ONE batch, in order', async () => {
    const { db, adapter } = await connected();
    const txn = await adapter.beginTransaction();
    const users = txn.createDataSource('users');

    await users.create({ id: 'u1', name: 'ada' });
    await users.create({ id: 'u2', name: 'bob' });

    // Nothing has been written yet — the buffer has not been flushed.
    expect(db.dump('users')).toEqual([]);

    await txn.commit();

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.batches[0][0].params).toEqual(['u1', 'ada']);
    expect(db.batches[0][1].params).toEqual(['u2', 'bob']);
    expect(db.dump('users')).toEqual([
      { id: 'u1', name: 'ada', age: null },
      { id: 'u2', name: 'bob', age: null },
    ]);
  });

  it('groups writes across several entities into the same batch', async () => {
    const db = new SqliteD1(SCHEMA, 'CREATE TABLE orders (id TEXT PRIMARY KEY, total INTEGER)');
    const adapter = new D1Adapter(db);
    await adapter.connect();

    const txn = await adapter.beginTransaction();
    await txn.createDataSource('users').create({ id: 'u1', name: 'ada' });
    await txn.createDataSource('orders').create({ id: 'o1', total: 10 });
    await txn.commit();

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.dump('users')).toHaveLength(1);
    expect(db.dump('orders')).toHaveLength(1);
  });

  it('commits an empty transaction without calling batch at all', async () => {
    const { db, adapter } = await connected();
    const txn = await adapter.beginTransaction();

    await txn.commit();

    expect(db.batches).toEqual([]);
    expect(db.executed).toEqual([]);
  });

  it('refuses a second commit on a finalized handle', async () => {
    const { adapter } = await connected();
    const txn = await adapter.beginTransaction();
    await txn.commit();

    await expect(txn.commit()).rejects.toThrow('Transaction already finalized');
  });

  it('refuses further data access after commit', async () => {
    const { adapter } = await connected();
    const txn = await adapter.beginTransaction();
    const users = txn.createDataSource('users');
    await txn.commit();

    await expect(users.findAll({
      where: {},
      orderBy: {},
      limit: -1,
      offset: 0,
      select: [],
    })).rejects.toThrow('Transaction already finalized');
  });
});

describe('D1Adapter transactions — rollback', () => {
  it('discards every buffered write and sends nothing', async () => {
    const { db, adapter } = await connected();
    const txn = await adapter.beginTransaction();
    const users = txn.createDataSource('users');

    await users.create({ id: 'u1', name: 'ada' });
    await txn.rollback();

    expect(db.batches).toEqual([]);
    expect(db.executed).toEqual([]);
    expect(db.dump('users')).toEqual([]);
  });

  it('is idempotent, because DatabaseService rolls back in a catch block', async () => {
    const { adapter } = await connected();
    const txn = await adapter.beginTransaction();

    await txn.rollback();
    await txn.rollback(); // must not throw
  });
});

describe('D1Adapter transactions — the documented cost of deferral', () => {
  it('does NOT observe its own pending writes (no read-your-own-writes)', async () => {
    const { adapter } = await connected();
    const txn = await adapter.beginTransaction();
    const users = txn.createDataSource('users');

    await users.create({ id: 'u1', name: 'ada' });

    // Buffered, not written — so a read inside the same transaction sees
    // committed state only. This is the design decision, pinned.
    expect(await users.findById('u1')).toBeNull();
    expect(await users.count({})).toBe(0);

    await txn.commit();
    expect(await adapter.createDataSource('users').findById('u1')).toMatchObject({ name: 'ada' });
  });

  it('refuses an in-transaction create with no primary key, naming the constraint', async () => {
    const { adapter } = await connected();
    const users = (await adapter.beginTransaction()).createDataSource('users');

    await expect(users.create({ name: 'ada' })).rejects.toThrow(CloudflareUnsupportedError);
    await expect(users.create({ name: 'ada' })).rejects.toThrow(/requires an explicit 'id'/);
  });

  it('allows an in-transaction create when the key is supplied', async () => {
    const { adapter } = await connected();
    const users = (await adapter.beginTransaction()).createDataSource('users');

    expect(await users.create({ id: 'u1', name: 'ada' })).toEqual({ id: 'u1', name: 'ada' });
  });
});

describe('D1Adapter transactions — update and delete read committed state first', () => {
  async function withRow(): Promise<{ db: SqliteD1; adapter: D1Adapter }> {
    const fixture = await connected();
    await fixture.adapter.createDataSource('users').create({ id: 'u1', name: 'ada', age: 36 });
    return fixture;
  }

  it('buffers an update and returns the locally merged row', async () => {
    const { db, adapter } = await withRow();
    const txn = await adapter.beginTransaction();

    const merged = await txn.createDataSource('users').update('u1', { age: 37 });

    expect(merged).toMatchObject({ id: 'u1', name: 'ada', age: 37 });
    expect(db.dump('users')[0]).toMatchObject({ age: 36 }); // not yet applied

    await txn.commit();
    expect(db.dump('users')[0]).toMatchObject({ age: 37 });
  });

  it('throws on updating a row that does not exist, buffering nothing', async () => {
    const { db, adapter } = await withRow();
    const txn = await adapter.beginTransaction();

    await expect(txn.createDataSource('users').update('missing', { age: 1 })).rejects.toThrow(
      /not found/,
    );

    await txn.commit();
    expect(db.batches).toEqual([]);
  });

  it('buffers a delete and reports whether the row existed', async () => {
    const { db, adapter } = await withRow();
    const txn = await adapter.beginTransaction();
    const users = txn.createDataSource('users');

    expect(await users.delete('missing')).toBe(false);
    expect(await users.delete('u1')).toBe(true);
    expect(db.dump('users')).toHaveLength(1); // still buffered

    await txn.commit();
    expect(db.dump('users')).toEqual([]);
  });

  it('rolls the whole sequence back when one batched statement fails', async () => {
    const { db, adapter } = await withRow();
    const txn = await adapter.beginTransaction();
    const users = txn.createDataSource('users');

    await users.create({ id: 'u2', name: 'bob' });
    // 'u1' already exists, so this INSERT violates the primary key.
    await users.create({ id: 'u1', name: 'clash' });

    await expect(txn.commit()).rejects.toThrow();

    // Neither write landed — batch() is one SQL transaction.
    expect(db.dump('users')).toHaveLength(1);
    expect(db.dump('users')[0]).toMatchObject({ id: 'u1', name: 'ada' });
  });
});
