/**
 * Coverage for the `_id` ↔ primary-key document mapping and per-entity target
 * resolution (`mongo-mapping.ts`).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  fromDriverDocument,
  resolveMongoTarget,
  toDriverDocument,
  toDriverId,
  toIdString,
} from '../../src/adapters/mongo/mongo-mapping.ts';
import { FakeObjectId, fakeObjectIdCtor } from '../fixtures/fake-mongo-client.ts';

describe('resolveMongoTarget — per-entity overrides and defaults', () => {
  it('an unmapped entity uses its own name and the default primary key', () => {
    const target = resolveMongoTarget('Widget', undefined);
    expect(target).toEqual({ collection: 'Widget', primaryKey: 'id', idType: 'auto' });
  });

  it('honours collection, primaryKey and idType overrides', () => {
    const mapping = {
      User: {
        collection: 'users',
        primaryKey: 'user_id',
        idType: 'raw' as const,
      },
    };
    const target = resolveMongoTarget('User', mapping);
    expect(target).toEqual({
      collection: 'users',
      primaryKey: 'user_id',
      idType: 'raw',
    });
  });

  it('a mapped entity without overrides still gets the primary-key default', () => {
    const target = resolveMongoTarget('User', { User: {} });
    expect(target.primaryKey).toBe('id');
    expect(target.idType).toBe('auto');
  });
});

describe('fromDriverDocument — _id → primary key on read', () => {
  it('renames _id to the mapped primary key and drops _id', () => {
    const row = fromDriverDocument({ _id: 'abc', name: 'Bolt' }, {
      collection: 'widgets',
      primaryKey: 'id',
      idType: 'auto',
    });
    expect(row).toEqual({ id: 'abc', name: 'Bolt' });
    expect(Object.hasOwn(row, '_id')).toBe(false);
  });

  it('uses the mapped primary key from a per-entity override', () => {
    const row = fromDriverDocument({ _id: 'abc' }, {
      collection: 'users',
      primaryKey: 'user_id',
      idType: 'auto',
    });
    expect(row).toEqual({ user_id: 'abc' });
  });

  it('leaves a document with no _id unchanged', () => {
    const row = fromDriverDocument({ name: 'Bolt' }, {
      collection: 'widgets',
      primaryKey: 'id',
      idType: 'auto',
    });
    expect(row).toEqual({ name: 'Bolt' });
  });

  it('never mutates the source document', () => {
    const source = { _id: 'abc', name: 'Bolt' };
    fromDriverDocument(source, {
      collection: 'widgets',
      primaryKey: 'id',
      idType: 'auto',
    });
    expect(Object.hasOwn(source, '_id')).toBe(true);
  });
});

describe('toDriverDocument — primary key → _id on write', () => {
  it('renames the primary key to _id and drops the primary key', () => {
    const doc = toDriverDocument({ id: 'abc', name: 'Bolt' }, {
      collection: 'widgets',
      primaryKey: 'id',
      idType: 'auto',
    });
    expect(doc).toEqual({ _id: 'abc', name: 'Bolt' });
    expect(Object.hasOwn(doc, 'id')).toBe(false);
  });

  it('leaves a row with no primary-key field unchanged', () => {
    const doc = toDriverDocument({ name: 'Bolt' }, {
      collection: 'widgets',
      primaryKey: 'id',
      idType: 'auto',
    });
    expect(doc).toEqual({ name: 'Bolt' });
  });

  it('does not mutate the source row', () => {
    const source = { id: 'abc' };
    toDriverDocument(source, {
      collection: 'widgets',
      primaryKey: 'id',
      idType: 'auto',
    });
    expect(Object.hasOwn(source, 'id')).toBe(true);
  });
});

describe('toIdString — driver id → string', () => {
  it('returns a string id as-is', () => {
    expect(toIdString('abc')).toBe('abc');
  });

  it('serializes an ObjectId via toString', () => {
    expect(toIdString(new fakeObjectIdCtor('507f1f77bcf86cd799439011'))).toBe(
      '507f1f77bcf86cd799439011',
    );
  });

  it('falls back to String() for an unexpected shape', () => {
    expect(toIdString(42)).toBe('42');
  });
});

describe('toDriverId — primary-key value → driver form', () => {
  it('raw idType passes the value through verbatim', () => {
    expect(toDriverId('507f1f77bcf86cd799439011', 'raw')).toBe(
      '507f1f77bcf86cd799439011',
    );
  });

  it('auto converts a valid 24-hex string to an ObjectId', () => {
    const id = toDriverId('507f1f77bcf86cd799439011', 'auto', fakeObjectIdCtor);
    // The result is a FakeObjectId (the ctor is an Object.assign wrapper, so check
    // the real class prototype, not the wrapper).
    expect(id).toBeInstanceOf(FakeObjectId);
    expect((id as { toString(): string }).toString()).toBe('507f1f77bcf86cd799439011');
  });

  it('auto uses a raw value when it is not a 24-hex string', () => {
    expect(toDriverId('not-an-objectid', 'auto', fakeObjectIdCtor)).toBe('not-an-objectid');
  });

  it('objectId forces conversion and reports an invalid value', () => {
    expect(() => toDriverId('not-an-objectid', 'objectId', fakeObjectIdCtor)).toThrow(
      /not a valid 24-hex/,
    );
  });

  it('objectId throws when no ObjectId constructor was supplied', () => {
    expect(() => toDriverId('507f1f77bcf86cd799439011', 'objectId')).toThrow(
      /needs the driver ObjectId/,
    );
  });
});

describe("mapping when the primary key IS the driver's own `_id` field", () => {
  const target = { collection: 'events', primaryKey: '_id', idType: 'raw' } as const;

  it('read keeps the id instead of writing then deleting the same field', () => {
    // `MongoEntityMapping.primaryKey` accepts any name, `'_id'` included — a
    // collection addressed by the driver's own field name. The unconditional
    // delete assigned `row['_id']` and then removed it, so the row came back
    // with no primary key at all.
    expect(fromDriverDocument({ _id: 7, name: 'launch' }, target)).toEqual({
      _id: 7,
      name: 'launch',
    });
  });

  it('write keeps the caller-supplied key rather than dropping it', () => {
    // Dropping `_id` on write is worse than losing it on read: the driver then
    // generates a fresh key and the row is stored under an id the caller never
    // chose, silently.
    expect(toDriverDocument({ _id: 7, name: 'launch' }, target)).toEqual({
      _id: 7,
      name: 'launch',
    });
  });

  it('a differently-named primary key still hides `_id` from the row', () => {
    // The guard is scoped to the equal-names case; the ordinary mapping is
    // unchanged.
    const renamed = { collection: 'events', primaryKey: 'id', idType: 'raw' } as const;
    expect(fromDriverDocument({ _id: 7, name: 'launch' }, renamed)).toEqual({
      id: 7,
      name: 'launch',
    });
    expect(toDriverDocument({ id: 7, name: 'launch' }, renamed)).toEqual({
      _id: 7,
      name: 'launch',
    });
  });
});
