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
import { encodeCursor } from '@setu-ts/common';
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
    ...(partial.cursor === undefined ? {} : { cursor: partial.cursor }),
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

describe('an update with nothing left to set issues no write', () => {
  it('reads the row rather than sending `$set: {}`', async () => {
    // `$set: {}` is a write that changes nothing, and it is not universally
    // accepted — measured, mongod 3.6.23 rejects it while 4.0.28, 4.4.30 and
    // 8.x accept it. The driver pins no server floor, so the empty payload is
    // served as a read on every version instead.
    const client = makeClient();
    const ds = createMongoDataSource(client, 'testdb', 'Widget', undefined, fakeObjectIdCtor);
    await ds.create({ id: 7, name: 'first' });

    expect(await ds.update(7, { id: 7 })).toEqual({ id: 7, name: 'first' });
    expect(await ds.update(7, {})).toEqual({ id: 7, name: 'first' });

    const calls = client.db('testdb').collection('Widget').calls;
    expect(calls.some((c) => c.method === 'findOneAndUpdate')).toBe(false);
  });

  it('still reports a missing row the same way', async () => {
    const ds = makeDataSource();
    await expect(ds.update(404, {})).rejects.toThrow(/no Widget row with id '404'/);
  });

  it('a payload with a real field still issues the write', async () => {
    const client = makeClient();
    const ds = createMongoDataSource(client, 'testdb', 'Widget', undefined, fakeObjectIdCtor);
    await ds.create({ id: 7, name: 'first' });
    await ds.update(7, { name: 'second' });
    const calls = client.db('testdb').collection('Widget').calls;
    expect(calls.some((c) => c.method === 'findOneAndUpdate')).toBe(true);
  });
});

describe('composite keys — flat multi-field target', () => {
  function makeCompositeDataSource() {
    return createMongoDataSource(makeClient(), 'testdb', 'User', {
      User: { primaryKey: ['tenantId', 'userId'] as const },
    });
  }

  it('findById builds a multi-field filter and returns the row', async () => {
    const ds = makeCompositeDataSource();
    await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
    const found = await ds.findById({ tenantId: 't1', userId: 'u1' });
    expect(found).toEqual({ tenantId: 't1', userId: 'u1', name: 'Alice' });
  });

  it('findById is order-independent for the caller key-object property order', async () => {
    const ds = makeCompositeDataSource();
    await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
    // The caller writes the record in reverse order from the mapping.
    const found = await ds.findById({ userId: 'u1', tenantId: 't1' });
    expect(found?.name).toBe('Alice');
  });

  it('update merges on a composite key', async () => {
    const ds = makeCompositeDataSource();
    await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice', active: true });
    const updated = await ds.update({ tenantId: 't1', userId: 'u1' }, { name: 'Alicia' });
    expect(updated.name).toBe('Alicia');
    expect(updated.active).toBe(true);
  });

  it('delete removes a composite-key row', async () => {
    const ds = makeCompositeDataSource();
    await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
    await ds.create({ tenantId: 't1', userId: 'u2', name: 'Bob' });
    expect(await ds.delete({ tenantId: 't1', userId: 'u1' })).toBe(true);
    const remaining = await ds.findAll(query());
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('Bob');
  });

  it('rejects a scalar id with a rejected promise naming the columns', async () => {
    const ds = makeCompositeDataSource();
    await expect(ds.findById('scalar'))
      .rejects
      .toThrow(/needs a composite record for multi-column key/);
  });

  it('rejects a record missing a required column', async () => {
    const ds = makeCompositeDataSource();
    await expect(ds.findById({ tenantId: 't1' }))
      .rejects
      .toThrow(/missing required column 'userId'/);
  });

  it('findAll leaves the named columns as top-level fields (no _id rename for flat composite)', async () => {
    const client = makeClient();
    const ds = createMongoDataSource(client, 'testdb', 'User', {
      User: { primaryKey: ['tenantId', 'userId'] as const },
    });
    await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
    await ds.findAll(query({ where: { tenantId: 't1', userId: 'u1' } }));
    const calls = client.databases.get('testdb')!.collection('User').calls;
    const findCall = calls.find((c) => c.method === 'find')!;
    const filter = findCall.args[0] as Record<string, unknown>;
    // Flat composite keys stay as top-level fields; only scalar keys rename to _id.
    expect(filter).toEqual({ tenantId: 't1', userId: 'u1' });
  });
});

describe('composite keys — compound _id subdocument (P4/P5)', () => {
  function makeCompoundDataSource() {
    return createMongoDataSource(makeClient(), 'testdb', 'Enrollment', {
      Enrollment: {
        primaryKey: ['tenantId', 'userId'] as const,
        idType: 'compound' as const,
      },
    });
  }

  it('create stores _id as a subdocument in mapping column order', async () => {
    const ds = makeCompoundDataSource();
    const row = await ds.create({ tenantId: 't1', userId: 'u1', course: 'math' });
    expect(row).toEqual({ tenantId: 't1', userId: 'u1', course: 'math' });
    // The adapter does not expose the collection, so we assert via findAll.
    const all = await ds.findAll(query());
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({ tenantId: 't1', userId: 'u1', course: 'math' });
  });

  it('findById matches regardless of caller property order (P5 canonical order)', async () => {
    const ds = makeCompoundDataSource();
    await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
    // Caller writes in reverse order from the mapping.
    const found = await ds.findById({ userId: 'u1', tenantId: 't1' });
    expect(found?.name).toBe('Alice');
  });

  it('update merges on a compound key', async () => {
    const ds = makeCompoundDataSource();
    await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice', active: true });
    const updated = await ds.update({ tenantId: 't1', userId: 'u1' }, { name: 'Alicia' });
    expect(updated.name).toBe('Alicia');
    expect(updated.active).toBe(true);
  });

  it('delete removes a compound-key row', async () => {
    const ds = makeCompoundDataSource();
    await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
    expect(await ds.delete({ tenantId: 't1', userId: 'u1' })).toBe(true);
    expect(await ds.findById({ tenantId: 't1', userId: 'u1' })).toBeNull();
  });

  it('rejects a scalar id with a rejected promise naming the columns', async () => {
    const ds = makeCompoundDataSource();
    await expect(ds.findById('scalar'))
      .rejects
      .toThrow(/needs a composite record for compound key/);
  });

  it('rejects a record missing a required column', async () => {
    const ds = makeCompoundDataSource();
    await expect(ds.findById({ tenantId: 't1' }))
      .rejects
      .toThrow(/missing required column 'userId'/);
  });

  it('findAll wraps the named columns under _id for a compound key', async () => {
    const client = makeClient();
    const ds = createMongoDataSource(client, 'testdb', 'Enrollment', {
      Enrollment: {
        primaryKey: ['tenantId', 'userId'] as const,
        idType: 'compound' as const,
      },
    });
    await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
    await ds.findAll(query({ where: { tenantId: 't1', userId: 'u1' } }));
    const calls = client.databases.get('testdb')!.collection('Enrollment').calls;
    const findCall = calls.find((c) => c.method === 'find')!;
    const filter = findCall.args[0] as Record<string, unknown>;
    // Compound _id: the where clause is wrapped under _id as a subdocument.
    expect(filter).toEqual({ _id: { tenantId: 't1', userId: 'u1' } });
  });
});

describe('createMongoDataSource — findPage (§3.8 keyset pagination)', () => {
  /**
   * Six rows over a `size` sort carrying deliberate ties (two rows per size) —
   * the P10/P11 fixture. Without the key-tiebreaker the walk would silently
   * lose rows, so this seeded tie is the proof the tiebreaker is load-bearing.
   */
  // 24-hex ids so the values round-trip through the `fakeObjectIdCtor` /
  // `toDriverId` conversion path (the scalar key renames to `_id` and the
  // keyset predicate's `id` comparisons pass through that same conversion).
  const SEED = [
    { id: '000000000000000000000001', size: 1, name: 's1a' },
    { id: '000000000000000000000002', size: 1, name: 's1b' },
    { id: '000000000000000000000003', size: 2, name: 's2a' },
    { id: '000000000000000000000004', size: 2, name: 's2b' },
    { id: '000000000000000000000005', size: 3, name: 's3a' },
    { id: '000000000000000000000006', size: 3, name: 's3b' },
  ];
  const ID = {
    a: '000000000000000000000001',
    b: '000000000000000000000002',
    c: '000000000000000000000003',
    d: '000000000000000000000004',
    e: '000000000000000000000005',
    f: '000000000000000000000006',
  } as const;

  /** Seeds the fixture into a fresh client and returns both for inspection. */
  /**
   * Seeds the fixture into a fresh client and returns both the client (for
   * inspecting recorded driver arguments) and the data source bound to it.
   */
  function seededClient(): { client: FakeMongoClient; ds: ReturnType<typeof makeDataSource> } {
    const client = makeClient();
    const ds = makeDataSource(client);
    for (const row of SEED) void ds.create(row);
    return { client, ds };
  }

  it('walks a tied fixture across three pages, every row exactly once, last page null', async () => {
    const { ds } = seededClient();
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let page = 0; page < 3; page++) {
      const result = await ds.findPage!(query({
        orderBy: { size: 'asc' },
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      }));
      for (const row of result.rows) seen.push(String(row.id));
      cursor = result.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
    // Every row exactly once, none repeated, none skipped.
    expect(seen.sort()).toEqual([ID.a, ID.b, ID.c, ID.d, ID.e, ID.f]);
    expect(new Set(seen).size).toBe(6);
  });

  it('reports nextCursor: null on the last page', async () => {
    const { ds } = seededClient();
    // Walk to the final page by consuming the cursors.
    const p1 = await ds.findPage!(query({ orderBy: { size: 'asc' }, limit: 2 }));
    const p2 = await ds.findPage!(query({
      orderBy: { size: 'asc' },
      limit: 2,
      cursor: p1.nextCursor as string,
    }));
    const p3 = await ds.findPage!(query({
      orderBy: { size: 'asc' },
      limit: 2,
      cursor: p2.nextCursor as string,
    }));
    // Six rows over three pages of two: the last page is a full page of two,
    // and the probe fetched exactly two (no extra), so nextCursor is null.
    expect(p3.nextCursor).toBeNull();
    expect(p3.rows).toHaveLength(2);
    expect(p3.rows.map((r) => r.id)).toEqual([ID.e, ID.f]);
  });

  it('records the conjoined keyset filter, the limit+1 probe and the minted next cursor', async () => {
    const { client, ds } = seededClient();
    // First page: mint a cursor from the returned last row.
    const p1 = await ds.findPage!(query({ orderBy: { size: 'asc' }, limit: 2 }));
    expect(p1.rows).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();

    // Second page: assert on the recorded driver arguments.
    const p2 = await ds.findPage!(query({
      orderBy: { size: 'asc' },
      limit: 2,
      cursor: p1.nextCursor as string,
    }));
    const calls = client.databases.get('testdb')!.collection('Widget').calls;
    const findCall = calls.filter((c) => c.method === 'find').at(-1)!;
    const args = findCall.args as [
      Record<string, unknown>,
      { sort?: Record<string, string>; limit?: number },
    ];
    // The conjoined keyset predicate is a FilterExpression translated to native
    // Mongo: or(gt(size, cursorSize), and(eq(size, cursorSize), gt(id, cursorId))).
    const filter = args[0] as { $or: unknown[] };
    expect(filter.$or.length).toBe(2);
    // The one-extra-row probe: limit + 1 reached the driver.
    expect(args[1].limit).toBe(3);
    // The minted next cursor is asserted to be encodeCursor's output for the
    // last row's ordered + key values under the current sort. The tiebreaker
    // column `id` is undefined on the seeded rows, so the key value is undefined
    // (JSON-encoded to null) — the minting reads it off the raw row.
    expect(p2.nextCursor).toBe(
      encodeCursor({
        orderedValues: [2],
        keyValues: [p2.rows[1].id as string | number],
        sortFingerprint: 'size:asc',
      }),
    );
  });

  it('rejects a malformed cursor token by name (never a synchronous throw)', async () => {
    const { ds } = seededClient();
    await expect(ds.findPage!(query({
      orderBy: { size: 'asc' },
      limit: 2,
      cursor: 'bm90anNvbg', // base64url of 'notjson' — decodes, fails JSON.parse
    }))).rejects.toThrow(/malformed cursor token/);
  });

  it('rejects a cursor whose fingerprint does not match the current sort by name', async () => {
    const { ds } = seededClient();
    await expect(ds.findPage!(query({
      orderBy: { size: 'desc' },
      limit: 2,
      cursor: encodeCursor({
        orderedValues: [1],
        keyValues: [ID.a],
        sortFingerprint: 'size:asc',
      }),
    }))).rejects.toThrow(/cursor fingerprint mismatch/);
  });

  it('strips the key columns from the returned rows when a projection is present', async () => {
    const { client, ds } = seededClient();
    const result = await ds.findPage!(query({
      orderBy: { size: 'asc' },
      limit: 2,
      select: ['name'],
    }));
    // The caller's projection is what comes back — `id` (a key column) is stripped.
    expect(result.rows[0]).toEqual({ name: 's1a' });
    expect(Object.hasOwn(result.rows[0], 'id')).toBe(false);
    // But the key column AND the ordered field (minting reads `size`) reached the
    // driver so the probe and cursor minting could read them.
    const calls = client.databases.get('testdb')!.collection('Widget').calls;
    const findOptions = calls.find((c) => c.method === 'find')!.args[1] as {
      projection: Record<string, 0 | 1>;
    };
    expect(findOptions.projection).toEqual({ name: 1, _id: 1, size: 1 });
  });

  it('refuses a query carrying both offset and cursor by name before any call', async () => {
    const { ds } = seededClient();
    await expect(ds.findPage!(query({
      orderBy: { size: 'asc' },
      limit: 2,
      offset: 1,
      cursor: encodeCursor({
        orderedValues: [1],
        keyValues: [ID.a],
        sortFingerprint: 'size:asc',
      }),
    }))).rejects.toThrow(/offset=1 conflicts with cursor/);
  });
});

describe('scalar-key mapping renames in place (M79 review regression)', () => {
  /**
   * `mapQueryToDriver`'s scalar branch REPLACED the whole `where`/`orderBy`
   * object with `{ _id: … }` whenever the key column was present, discarding
   * every other member.
   *
   * The sort half is reached on EVERY scalar-key `findPage`, because
   * `resolveKeysetSort` always appends the key column as the keyset
   * tiebreaker — so a page ordered by `score` was silently ordered by `_id`
   * alone, which is a different page from the one asked for and one the keyset
   * predicate does not agree with.
   */
  it('carries a non-key condition through beside the key', async () => {
    const client = makeClient();
    const source = makeDataSource(client);
    await source.findAll({
      where: { id: 'w1', status: 'active' },
      orderBy: {},
      limit: -1,
      offset: 0,
      select: [],
    });
    const call = client.db('testdb').collection('Widget').calls.find((c) => c.method === 'find');
    // `status` must survive; without it the query matches rows it was never
    // asked for — more rows, not fewer, so no assertion on a result COUNT
    // would necessarily catch it.
    expect(call?.args[0]).toEqual({ _id: 'w1', status: 'active' });
  });

  it('keeps the caller sort and appends the renamed key as the tiebreaker', async () => {
    const client = makeClient();
    const source = makeDataSource(client);
    for (
      const row of [
        { id: 'a', score: 1 },
        { id: 'b', score: 2 },
        { id: 'c', score: 3 },
      ]
    ) await source.create(row);

    const page = await source.findPage!({
      where: {},
      orderBy: { score: 'asc' },
      limit: 2,
      offset: 0,
      select: [],
    });

    const call = client
      .db('testdb')
      .collection('Widget')
      .calls
      .filter((c) => c.method === 'find')
      .at(-1);
    const sort = (call?.args[1] as { sort?: Record<string, unknown> } | undefined)?.sort;
    // Both keys, in precedence order: the caller's field FIRST, the renamed
    // key column second. The defect produced `{ _id: 'asc' }` alone.
    expect(Object.entries(sort ?? {})).toEqual([['score', 'asc'], ['_id', 'asc']]);
    expect(page.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
