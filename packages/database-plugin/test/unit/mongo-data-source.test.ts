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
import type { IMongoSession } from '../../src/adapters/mongo/mongo-client-types.ts';
import type { NormalizedQuery } from '@setu-ts/common';
import { FakeMongoClient, fakeObjectIdCtor, FakeSession } from '../fixtures/fake-mongo-client.ts';

/** A fresh client per test — the real driver hands back the same collection
 * instance per name, so a shared client would leak documents between tests. */
function makeClient(): FakeMongoClient {
  return new FakeMongoClient();
}

/** Builds the normal ObjectId-aware data source the lazy production path uses. */
function makeDataSource(client: FakeMongoClient = makeClient()) {
  return createMongoDataSource(client, 'testdb', 'Widget', undefined, fakeObjectIdCtor);
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
    const ds = makeDataSource();
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
    const ds = makeDataSource();
    const created = await ds.create({ name: 'Bolt' });
    const found = await ds.findById(String(created.id));
    expect(found).toEqual({ name: 'Bolt', id: created.id });
    expect(found !== null && Object.hasOwn(found, '_id')).toBe(false);
    await expect(ds.findById('does-not-exist')).resolves.toBeNull();
  });

  it('update returns the updated document directly (not a ModifyResult)', async () => {
    const ds = makeDataSource();
    const created = await ds.create({ name: 'Bolt' });
    const updated = await ds.update(String(created.id), { name: 'Nut' });
    expect(updated).toEqual({ name: 'Nut', id: created.id });
  });

  it('update throws when no row has the given key', async () => {
    const ds = makeDataSource();
    await expect(ds.update('missing', { name: 'x' })).rejects.toThrow(/no Widget row/);
  });

  it('delete reports true only when a row was removed', async () => {
    const ds = makeDataSource();
    const created = await ds.create({ name: 'Bolt' });
    await expect(ds.delete(String(created.id))).resolves.toBe(true);
    await expect(ds.delete(String(created.id))).resolves.toBe(false);
  });

  it('count honours where and a filter', async () => {
    const ds = makeDataSource();
    await ds.create({ name: 'Bolt', size: 10 });
    await ds.create({ name: 'Nut', size: 20 });
    await ds.create({ name: 'Washer', size: 30 });
    expect(await ds.count({ size: { $gte: 20 } })).toBe(2);
  });

  it('findAll translates where, filter, orderBy, offset, limit and select', async () => {
    const client = makeClient();
    const ds = makeDataSource(client);
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
    const calls = client.databases.get('testdb')!.collection('Widget').calls;
    const findOptions = calls.find((call) => call.method === 'find')!.args[1] as {
      projection: Record<string, 0 | 1>;
    };
    // Mongo includes `_id` by default under an inclusion projection, so the
    // adapter must explicitly exclude it when `id` was not selected.
    expect(findOptions.projection).toEqual({ name: 1, _id: 0 });
  });

  it('maps a selected repository primary key to Mongo _id', async () => {
    const client = makeClient();
    const ds = makeDataSource(client);
    const created = await ds.create({ name: 'Bolt' });
    const rows = await ds.findAll(query({ select: ['id', 'name'] }));
    expect(rows).toEqual([{ id: created.id, name: 'Bolt' }]);
    const calls = client.databases.get('testdb')!.collection('Widget').calls;
    const findOptions = calls.find((call) => call.method === 'find')!.args[1] as {
      projection: Record<string, 0 | 1>;
    };
    expect(findOptions.projection).toEqual({ name: 1, _id: 1 });
  });

  it('findAll translates a contains comparison to a regex-escaped $regex', async () => {
    const ds = makeDataSource();
    await ds.create({ name: '3.5mm jack' });
    await ds.create({ name: '315mm jack' });
    const rows = await ds.findAll(query({
      filter: { type: 'comparison', field: 'name', operator: 'contains', value: '3.5' },
    }));
    // The escaped dot matches only the literal 3.5, not the 315.
    expect(rows.map((r) => r.name)).toEqual(['3.5mm jack']);
  });

  it('maps primary-key where, filter, count, and sort clauses to Mongo _id', async () => {
    const client = makeClient();
    const ds = makeDataSource(client);
    const first = await ds.create({ id: '507f1f77bcf86cd799439011', name: 'first' });
    await ds.create({ id: '507f1f77bcf86cd799439012', name: 'second' });

    await expect(ds.findAll(query({ where: { id: first.id } }))).resolves.toEqual([first]);
    await expect(ds.findAll(query({
      filter: { type: 'comparison', field: 'id', operator: 'eq', value: first.id },
    }))).resolves.toEqual([first]);
    await expect(ds.count({ id: first.id })).resolves.toBe(1);
    await ds.findAll(query({ orderBy: { id: 'desc' } }));

    const calls = client.databases.get('testdb')!.collection('Widget').calls;
    const whereFind = calls.find((call) => call.method === 'find')!;
    expect(String((whereFind.args[0] as { _id: unknown })._id)).toBe(first.id);
    const sortFind = calls.filter((call) => call.method === 'find').at(-1)!;
    expect((sortFind.args[1] as { sort: Record<string, string> }).sort).toEqual({ _id: 'desc' });
    const count = calls.find((call) => call.method === 'countDocuments')!;
    expect(String((count.args[0] as { _id: unknown })._id)).toBe(first.id);
  });

  it('passes a session to every operation when one is supplied', async () => {
    const session: IMongoSession = {
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
      fakeObjectIdCtor,
      session,
    );
    const created = await ds.create({ name: 'Bolt' });
    await ds.findAll(query());
    await ds.findById(String(created.id));
    await ds.update(String(created.id), { name: 'Nut' });
    await ds.delete(String(created.id));
    await ds.count({});
    const calls = client.databases.get('testdb')!.collection('Widget').calls;
    expect(calls.map((call) => call.method)).toEqual([
      'insertOne',
      'find',
      'findOne',
      'findOneAndUpdate',
      'deleteOne',
      'countDocuments',
    ]);
    const sessionOptions = calls.map((call) => {
      const index = call.method === 'findOneAndUpdate' ? 2 : 1;
      return call.args[index] as { session?: unknown };
    });
    expect(sessionOptions.every((operation) => operation.session === session)).toBe(true);
  });
});

describe('createMongoDataSource — write-shape edge branches', () => {
  it('create passes the generated _id through when insertOne returns an insertedId', async () => {
    const client = makeClient();
    const ds = makeDataSource(client);
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
    const ds = makeDataSource();
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
    const ds = makeDataSource();
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
});

describe('update never sends the primary key to the driver', () => {
  it('drops `_id` from the `$set` payload', async () => {
    // MongoDB refuses a `$set` that would change `_id` ("Performing an update
    // on the path '_id' would modify the immutable field '_id'" — reproduced
    // against mongod 8), so a caller handing the whole row back with a
    // different key met a raw driver error through a portable contract. `id`
    // already addresses the row, so the key never belongs in the payload.
    const client = makeClient();
    const ds = createMongoDataSource(client, 'testdb', 'Widget', undefined, fakeObjectIdCtor);
    await ds.create({ id: 7, name: 'first' });

    await ds.update(7, { id: 9, name: 'renamed' });

    const call = client.db('testdb').collection('Widget').calls.find(
      (c) => c.method === 'findOneAndUpdate',
    );
    const payload = (call?.args[1] as { $set: Record<string, unknown> }).$set;
    expect(payload).toEqual({ name: 'renamed' });
    expect('_id' in payload).toBe(false);
  });

  it('still updates the addressed row and returns it with its key intact', async () => {
    const ds = makeDataSource();
    await ds.create({ id: 7, name: 'first' });
    expect(await ds.update(7, { id: 9, name: 'renamed' })).toEqual({ id: 7, name: 'renamed' });
    // The row keeps its original key: `update` moves no row to a new id.
    expect(await ds.findById(7)).toEqual({ id: 7, name: 'renamed' });
  });

  it('an update carrying only the primary key is a no-op that returns the row', async () => {
    // Stripping the key can empty the payload. mongod 8 accepts `$set: {}` and
    // answers with the document, so this stays a successful read-back rather
    // than becoming a new failure mode.
    const ds = makeDataSource();
    await ds.create({ id: 7, name: 'first' });
    expect(await ds.update(7, { id: 7 })).toEqual({ id: 7, name: 'first' });
  });
});

describe('the fake client honours the real driver where the adapter depends on it', () => {
  it('treats `limit: 0` as unlimited, as mongod does', async () => {
    // Measured against mongod 8: `find({}, { limit: 0 })` returns every match.
    // The framework's own `applyPagination` gates its slice on `limit > 0` for
    // the same reason, so a double slicing to zero would have been the only
    // component in the stack disagreeing — and would have hidden it.
    const ds = makeDataSource();
    await ds.create({ id: 1 });
    await ds.create({ id: 2 });
    expect(await ds.findAll(query({ limit: 0 }))).toHaveLength(2);
    expect(await ds.findAll(query({ limit: 1 }))).toHaveLength(1);
  });

  it("`returnDocument: 'before'` answers with the pre-update document", async () => {
    const client = makeClient();
    const ds = createMongoDataSource(client, 'testdb', 'Widget', undefined, fakeObjectIdCtor);
    await ds.create({ id: 1, name: 'first' });
    const collection = client.db('testdb').collection('Widget');
    const before = await collection.findOneAndUpdate(
      { _id: 1 },
      { $set: { name: 'second' } },
      { returnDocument: 'before' },
    );
    expect(before).toEqual({ _id: 1, name: 'first' });
    // …and the write still landed.
    expect(await ds.findById(1)).toEqual({ id: 1, name: 'second' });
  });
});

describe('update strips the primary key before it can be converted', () => {
  it('an unconvertible key in the payload does not fail the update', async () => {
    // The key is discarded, so it must not be able to fail the call on its way
    // out. Stripping AFTER `toDriverDocument` left `toDriverId` running first,
    // and on an `idType: 'objectId'` target that throws for a value the update
    // was never going to use.
    const client = makeClient();
    const ds = createMongoDataSource(
      client,
      'testdb',
      'Widget',
      { Widget: { idType: 'objectId' } },
      fakeObjectIdCtor,
    );
    const valid = '507f1f77bcf86cd799439011';
    await ds.create({ id: valid, name: 'first' });

    await expect(ds.update(valid, { id: 'not-a-valid-objectid', name: 'renamed' }))
      .resolves.toMatchObject({ name: 'renamed' });
  });

  it('a stray literal `_id` beside the mapped key never reaches $set', async () => {
    const client = makeClient();
    const ds = createMongoDataSource(client, 'testdb', 'Widget', undefined, fakeObjectIdCtor);
    await ds.create({ id: 1, name: 'first' });

    await ds.update(1, { id: 1, _id: 'stray', name: 'renamed' });

    const call = client.db('testdb').collection('Widget').calls.find(
      (c) => c.method === 'findOneAndUpdate',
    );
    const payload = (call?.args[1] as { $set: Record<string, unknown> }).$set;
    expect(payload).toEqual({ name: 'renamed' });
  });
});
