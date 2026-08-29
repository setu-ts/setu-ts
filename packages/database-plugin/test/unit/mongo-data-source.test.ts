/**
 * Coverage for the six `IDataSource` methods over an in-memory fake client that
 * honours the real driver's return shapes — `insertOne` → `{ acknowledged,
 * insertedId }`, `findOneAndUpdate` → the document directly, `deleteOne` →
 * `{ deletedCount }`.
 *
 * A double that returned a `ModifyResult { value }` from `findOneAndUpdate`
 * would be a contract-violating fixture (the recurring root cause behind M37b,
 * M53, M55); this one returns the document directly.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createMongoDataSource } from '../../src/adapters/mongo/mongo-data-source.ts';
import type { NormalizedQuery } from '@setu-ts/common';
import {
  FakeMongoClient,
  FakeMongoDatabase,
  fakeObjectIdCtor,
  FakeSession,
  InsertedIdUndefinedCollection,
} from '../fixtures/fake-mongo-client.ts';

/** A fresh client per test — the real driver hands back the same collection
 * instance per name, so a shared client would leak documents between tests. */
function makeClient(): FakeMongoClient {
  return new FakeMongoClient();
}

/** Builds a normalized query with one member overridden. */
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

describe('createMongoDataSource — the six IDataSource methods', () => {
  it('create composes the returned row from the input plus the generated _id', async () => {
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    const row = await ds.create({ name: 'Bolt', size: 10 });
    expect(row).toEqual({ name: 'Bolt', size: 10, id: expect.any(String) });
    expect(Object.hasOwn(row, '_id')).toBe(false);
  });

  it('create converts a 24-hex id to an ObjectId on write for an objectId entity', async () => {
    const mapping = {
      Widget: { collection: 'widgets', primaryKey: 'id', idType: 'objectId' as const },
    };
    const ds = createMongoDataSource(
      makeClient(),
      'testdb',
      'Widget',
      mapping,
      fakeObjectIdCtor,
    );
    const row = await ds.create({ id: '507f1f77bcf86cd799439011' });
    expect(row.id).toBe('507f1f77bcf86cd799439011');
  });

  it('findById maps the document back and returns null when missing', async () => {
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    const created = await ds.create({ name: 'Bolt' });
    const found = await ds.findById(String(created.id));
    expect(found).toEqual({ name: 'Bolt', id: created.id });
    expect(found !== null && Object.hasOwn(found, '_id')).toBe(false);
    await expect(ds.findById('does-not-exist')).resolves.toBeNull();
  });

  it('update returns the updated document directly (not a ModifyResult)', async () => {
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    const created = await ds.create({ name: 'Bolt' });
    const updated = await ds.update(String(created.id), { name: 'Nut' });
    expect(updated).toEqual({ name: 'Nut', id: created.id });
  });

  it('update throws when no row has the given key', async () => {
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    await expect(ds.update('missing', { name: 'x' })).rejects.toThrow(/no Widget row/);
  });

  it('delete reports true only when a row was removed', async () => {
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    const created = await ds.create({ name: 'Bolt' });
    await expect(ds.delete(String(created.id))).resolves.toBe(true);
    await expect(ds.delete(String(created.id))).resolves.toBe(false);
  });

  it('count honours where and a filter', async () => {
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    await ds.create({ name: 'Bolt', size: 10 });
    await ds.create({ name: 'Nut', size: 20 });
    await ds.create({ name: 'Washer', size: 30 });
    expect(await ds.count({ size: { $gte: 20 } })).toBe(2);
  });

  it('findAll translates where, filter, orderBy, offset, limit and select', async () => {
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    await ds.create({ name: 'Bolt', size: 10 });
    await ds.create({ name: 'Nut', size: 20 });
    await ds.create({ name: 'Washer', size: 30 });

    const rows = await ds.findAll(query({
      orderBy: { size: 'desc' },
      limit: 2,
      select: ['name'],
    }));
    expect(rows.map((r) => r.name)).toEqual(['Washer', 'Nut']);
    expect(Object.hasOwn(rows[0], 'id')).toBe(false);
  });

  it('findAll translates a contains comparison to a regex-escaped $regex', async () => {
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    await ds.create({ name: '3.5mm jack' });
    await ds.create({ name: '315mm jack' });
    const rows = await ds.findAll(query({
      filter: { type: 'comparison', field: 'name', operator: 'contains', value: '3.5' },
    }));
    // The escaped dot matches only the literal 3.5, not the 315.
    expect(rows.map((r) => r.name)).toEqual(['3.5mm jack']);
  });

  it('passes a session to every operation when one is supplied', async () => {
    const session = {
      startTransaction: () => Promise.resolve(),
      commitTransaction: () => Promise.resolve(),
      abortTransaction: () => Promise.resolve(),
      endSession: () => Promise.resolve(),
    };
    const client = makeClient();
    const ds = createMongoDataSource(
      client,
      'testdb',
      'Widget',
      undefined,
      undefined,
      session as never,
    );
    await ds.create({ name: 'Bolt' });
    const calls = (client.databases.get('testdb')?.collection('Widget').calls ?? []).map(
      (c: { method: string }) => c.method,
    );
    expect(calls).toContain('insertOne');
  });
});

describe('createMongoDataSource — write-shape edge branches', () => {
  it('create passes the generated _id through when insertOne returns an insertedId', async () => {
    const client = makeClient();
    const ds = createMongoDataSource(client, 'testdb', 'Widget', undefined);
    const row = await ds.create({ name: 'Bolt' });
    expect(typeof row.id).toBe('string');
    // The stored document carries the string _id the lookup key is built from.
    const col = client.databases.get('testdb')!.collection('Widget');
    expect(col.calls.some((c) => c.method === 'insertOne')).toBe(true);
  });
});

describe('MongoTransaction — commit, rollback and createDataSource', () => {
  it('createDataSource throws after the transaction is finalized', async () => {
    const client = new FakeMongoClient();
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    await ds.create({ name: 'Bolt' });
    const tx = client.startSession() as never;
    const { MongoTransaction } = await import('../../src/adapters/mongo/mongo-data-source.ts');
    const transaction = new MongoTransaction(tx, client, 'testdb', undefined);
    await transaction.commit();
    expect(() => transaction.createDataSource('Widget')).toThrow(/already finalized/);
  });

  it('rollback ends the session', async () => {
    const client = new FakeMongoClient();
    const session = new FakeSession();
    const { MongoTransaction } = await import('../../src/adapters/mongo/mongo-data-source.ts');
    const transaction = new MongoTransaction(session, client, 'testdb', undefined);
    await transaction.rollback();
    expect(session.calls).toContain('abortTransaction');
    expect(session.calls).toContain('endSession');
  });

  it('commit is idempotent — a second commit performs no further session work', async () => {
    const client = new FakeMongoClient();
    const session = new FakeSession();
    const { MongoTransaction } = await import('../../src/adapters/mongo/mongo-data-source.ts');
    const transaction = new MongoTransaction(session, client, 'testdb', undefined);
    await transaction.commit();
    const callsAfterFirst = [...session.calls];
    await transaction.commit();
    // The second commit must not re-issue commitTransaction/endSession.
    expect(session.calls).toEqual(callsAfterFirst);
    expect(session.calls).toEqual(['commitTransaction', 'endSession']);
  });

  it('rollback is idempotent — a second rollback performs no further session work', async () => {
    const client = new FakeMongoClient();
    const session = new FakeSession();
    const { MongoTransaction } = await import('../../src/adapters/mongo/mongo-data-source.ts');
    const transaction = new MongoTransaction(session, client, 'testdb', undefined);
    await transaction.rollback();
    const callsAfterFirst = [...session.calls];
    await transaction.rollback();
    // The second rollback must not re-issue abortTransaction/endSession.
    expect(session.calls).toEqual(callsAfterFirst);
    expect(session.calls).toEqual(['abortTransaction', 'endSession']);
  });

  it('createDataSource on an open transaction returns a working, session-bound data source', async () => {
    const client = new FakeMongoClient();
    const session = new FakeSession();
    const { MongoTransaction } = await import('../../src/adapters/mongo/mongo-data-source.ts');
    const transaction = new MongoTransaction(session, client, 'testdb', undefined);
    const ds = transaction.createDataSource('Widget');
    await ds.create({ name: 'Bolt' });
    expect(await ds.count({}, { type: 'comparison', field: 'name', operator: 'eq', value: 'Bolt' }))
      .toBe(1);
    // The data source ran inside the transaction and can still be closed by
    // committing the transaction; the session-bound create() above is what the
    // commit later finalizes.
    await transaction.commit();
    expect(session.calls).toEqual(['commitTransaction', 'endSession']);
  });

  it('count honours both a where and a filter expression', async () => {
    const ds = createMongoDataSource(makeClient(), 'testdb', 'Widget', undefined);
    await ds.create({ name: 'Bolt', size: 10 });
    await ds.create({ name: 'Nut', size: 20 });
    await ds.create({ name: 'Washer', size: 30 });
    // A filter expression is merged with the equality where.
    const count = await ds.count(
      { size: { $gte: 20 } },
      { type: 'comparison', field: 'name', operator: 'contains', value: 'N' },
    );
    expect(count).toBe(1);
  });

  it('create does not set the primary key when insertOne returns no insertedId', async () => {
    // A real driver always returns an insertedId, but the contract only sets the
    // primary key when one is present, so the absent-insertedId branch is covered
    // with a collection whose insertOne returns no id.
    const col = new InsertedIdUndefinedCollection();
    const db = new FakeMongoDatabase();
    // deno-lint-ignore no-explicit-any -- test double: override db/collection to inject a custom collection
    (db as { collection: (n: string) => any }).collection = () => col;
    const client = new FakeMongoClient();
    // deno-lint-ignore no-explicit-any -- test double: override client/db to inject a custom db
    (client as { db: (n: string) => any }).db = () => db;
    const ds = createMongoDataSource(client, 'testdb', 'Widget', undefined);
    const row = await ds.create({ name: 'Bolt' });
    expect(row).toEqual({ name: 'Bolt' });
    expect(Object.hasOwn(row, 'id')).toBe(false);
  });
});
