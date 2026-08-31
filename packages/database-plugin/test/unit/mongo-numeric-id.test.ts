/**
 * Regression guard for the numeric primary key.
 *
 * `IDataSource.findById`/`update`/`delete` accept `string | number`
 * (`common/src/services/database.ts:141`), and a collection keyed by
 * application-assigned numbers is an ordinary Mongo schema. Under the default
 * `'auto'` mapping the adapter converted through `ObjectId.isValid`, which the
 * REAL driver answers `true` for on **any** number (measured on
 * `mongodb@6.21.0`: `isValid(5)`, `isValid(0)` and `isValid(1234567890)`)
 * while `new ObjectId('5')` throws `BSONError: input must be a 24 character
 * hex string, 12 byte Uint8Array, or an integer`. Every entry point that
 * touched a numeric id therefore threw against a real server.
 *
 * The suite could not see it because the fixture's `isValid` answered `false`
 * for a number — the contract-violating double this repo keeps re-finding. The
 * fixture now mirrors the driver, so these cases fail without the mapping fix.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';
import { createMongoDataSource } from '../../src/adapters/mongo/mongo-data-source.ts';
import {
  fromDriverDocument,
  fromDriverId,
  toDriverId,
} from '../../src/adapters/mongo/mongo-mapping.ts';
import { FakeMongoClient, fakeObjectIdCtor } from '../fixtures/fake-mongo-client.ts';

const query = (partial: Partial<NormalizedQuery> = {}): NormalizedQuery => ({
  where: partial.where ?? {},
  orderBy: partial.orderBy ?? {},
  limit: partial.limit ?? -1,
  offset: partial.offset ?? 0,
  select: partial.select ?? [],
  ...(partial.filter === undefined ? {} : { filter: partial.filter }),
});

describe('numeric primary keys under the default "auto" mapping', () => {
  it('passes a number through instead of constructing an ObjectId from it', () => {
    expect(toDriverId(7, 'auto', fakeObjectIdCtor)).toBe(7);
    expect(toDriverId(0, 'auto', fakeObjectIdCtor)).toBe(0);
    expect(toDriverId(1234567890, 'auto', fakeObjectIdCtor)).toBe(1234567890);
  });

  it('still converts a 24-hex string under "auto"', () => {
    const converted = toDriverId('507f1f77bcf86cd799439011', 'auto', fakeObjectIdCtor);
    expect(String(converted)).toBe('507f1f77bcf86cd799439011');
    expect(typeof converted).toBe('object');
  });

  it('refuses a numeric id by name when "objectId" is forced', () => {
    expect(() => toDriverId(7, 'objectId', fakeObjectIdCtor)).toThrow(
      "Cannot map id '7' to ObjectId",
    );
  });

  it('serves the whole IDataSource surface for a numeric key', async () => {
    const client = new FakeMongoClient();
    const source = createMongoDataSource(client, 'app', 'Widget', undefined, fakeObjectIdCtor);

    const created = await source.create({ id: 7, name: 'numeric' });
    // The key keeps its own type, as every other adapter's does.
    expect(created).toEqual({ id: 7, name: 'numeric' });
    await expect(source.findById(7)).resolves.toEqual({ id: 7, name: 'numeric' });
    await expect(source.findAll(query({ where: { id: 7 } }))).resolves.toEqual([
      { id: 7, name: 'numeric' },
    ]);
    await expect(source.count({ id: 7 })).resolves.toBe(1);
    await expect(source.update(7, { name: 'renamed' })).resolves.toEqual({
      id: 7,
      name: 'renamed',
    });
    await expect(source.delete(7)).resolves.toBe(true);
  });

  it('round-trips the key create() returned', async () => {
    // `create()` stringifying a scalar key made this call miss silently: `'7'`
    // is a legitimately different Mongo key from `7`.
    const client = new FakeMongoClient();
    const source = createMongoDataSource(client, 'app', 'Widget', undefined, fakeObjectIdCtor);
    const created = await source.create({ id: 7, name: 'numeric' });
    await expect(source.findById(created.id as number)).resolves.toEqual(created);
  });
});

describe('a legal `_id: null` document', () => {
  it('is mapped rather than crashing the reader', () => {
    // One document per collection may carry `_id: null`, and `toIdString`
    // dereferenced `.toString` before any nullish check, so reading such a
    // document raised `TypeError: Cannot read properties of null`.
    const target = { collection: 'Widget', primaryKey: ['id'], idType: 'auto' } as const;
    expect(fromDriverDocument({ _id: null, name: 'null-key' }, target)).toEqual({
      id: null,
      name: 'null-key',
    });
  });
});

describe('fromDriverId — which `_id` values keep their own type', () => {
  it('preserves every JSON scalar and renders anything else', () => {
    expect(fromDriverId(7)).toBe(7);
    expect(fromDriverId('raw-key')).toBe('raw-key');
    expect(fromDriverId(true)).toBe(true);
    expect(fromDriverId(null)).toBeNull();
    // An ObjectId is rendered, because the instance would not survive
    // `JSON.stringify` in a handler and the hex string is what callers address.
    expect(fromDriverId(new fakeObjectIdCtor('507f1f77bcf86cd799439011'))).toBe(
      '507f1f77bcf86cd799439011',
    );
    // A null-prototype `_id` has no `toString`, so the renderer falls back.
    expect(fromDriverId(Object.assign(Object.create(null), { a: 1 }))).toBe('[object Object]');
  });
});

describe('primary-key mapping inside a composed filter', () => {
  it('maps the primary key to _id through and/or branches and converts its values', async () => {
    const client = new FakeMongoClient();
    const source = createMongoDataSource(client, 'app', 'Widget', undefined, fakeObjectIdCtor);
    await source.create({ id: 7, name: 'numeric' });
    await source.create({ id: 8, name: 'other' });

    await expect(source.findAll(query({
      filter: {
        type: 'and',
        filters: [
          { type: 'comparison', field: 'id', operator: 'in', value: [7, 8] },
          { type: 'comparison', field: 'name', operator: 'eq', value: 'numeric' },
        ],
      },
    }))).resolves.toEqual([{ id: 7, name: 'numeric' }]);

    await expect(source.count({}, {
      type: 'or',
      filters: [
        { type: 'comparison', field: 'id', operator: 'eq', value: 7 },
        { type: 'comparison', field: 'id', operator: 'eq', value: 8 },
      ],
    })).resolves.toBe(2);
  });
});
