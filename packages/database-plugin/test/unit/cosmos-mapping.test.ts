/**
 * Unit tests for the Cosmos entity mapping: target resolution, the row ↔
 * document translation and the system-property strip.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';
import {
  documentField,
  fromDocument,
  normalizePartitionKeyPaths,
  parsePartitionKeyPath,
  readPath,
  renderPartitionKeyPath,
  resolveCosmosTarget,
  toDocument,
} from '../../src/adapters/cosmos/cosmos-mapping.ts';

describe('resolveCosmosTarget', () => {
  it('defaults the container to the entity name and the key to id', () => {
    expect(resolveCosmosTarget('Order', undefined)).toEqual({
      container: 'Order',
      primaryKey: 'id',
      partitionKeyPaths: null,
    });
  });

  it('applies a per-entity override', () => {
    expect(
      resolveCosmosTarget('Order', {
        Order: { container: 'orders', primaryKey: 'orderId', partitionKey: 'tenantId' },
      }),
    ).toEqual({
      container: 'orders',
      primaryKey: 'orderId',
      partitionKeyPaths: [['tenantId']],
    });
  });

  it('leaves an unmapped entity on its defaults when other entities are mapped', () => {
    expect(resolveCosmosTarget('Other', { Order: { container: 'orders' } }).container)
      .toBe('Other');
  });
});

describe('normalizePartitionKeyPaths', () => {
  it('collapses the three spellings onto one segment-list shape', () => {
    expect(normalizePartitionKeyPaths('tenantId')).toEqual([['tenantId']]);
    expect(normalizePartitionKeyPaths(['address', 'city'])).toEqual([['address', 'city']]);
    expect(normalizePartitionKeyPaths([['t'], ['r']])).toEqual([['t'], ['r']]);
  });

  it('reports nothing configured for an absent or empty value', () => {
    expect(normalizePartitionKeyPaths(undefined)).toBeNull();
    expect(normalizePartitionKeyPaths([])).toBeNull();
  });
});

describe('partition-key path rendering', () => {
  it('parses a definition path into segments and renders it back', () => {
    expect(parsePartitionKeyPath('/tenantId')).toEqual(['tenantId']);
    expect(parsePartitionKeyPath('/address/city')).toEqual(['address', 'city']);
    expect(renderPartitionKeyPath(['address', 'city'])).toBe('/address/city');
  });
});

describe('readPath', () => {
  it('walks a nested value and reports undefined for an absent segment', () => {
    const row = { address: { city: 'Kolkata' }, scalar: 1 };
    expect(readPath(row, ['address', 'city'])).toBe('Kolkata');
    expect(readPath(row, ['address', 'zip'])).toBeUndefined();
    expect(readPath(row, ['scalar', 'deeper'])).toBeUndefined();
    expect(readPath(row, ['missing', 'x'])).toBeUndefined();
  });
});

describe('fromDocument', () => {
  const target = resolveCosmosTarget('Order', { Order: { primaryKey: 'orderId' } });

  it('strips every system property', () => {
    const row = fromDocument({
      id: 'o1',
      total: 3,
      _rid: 'r',
      _self: 's',
      _etag: 'e',
      _attachments: 'a',
      _ts: 1,
    }, target);
    expect(row).toEqual({ orderId: 'o1', total: 3 });
  });

  it('keeps id in place when the mapped key IS id', () => {
    const plain = resolveCosmosTarget('Order', undefined);
    expect(fromDocument({ id: 'o1', _ts: 1 }, plain)).toEqual({ id: 'o1' });
  });

  it('leaves a document with no id untouched beyond the strip', () => {
    expect(fromDocument({ total: 1, _ts: 2 }, target)).toEqual({ total: 1 });
  });
});

describe('toDocument', () => {
  it('renames the mapped primary key onto id', () => {
    const target = resolveCosmosTarget('Order', { Order: { primaryKey: 'orderId' } });
    expect(toDocument({ orderId: 'o1', total: 2 }, target)).toEqual({ id: 'o1', total: 2 });
  });

  it('leaves a row alone when the mapped key IS id', () => {
    const target = resolveCosmosTarget('Order', undefined);
    expect(toDocument({ id: 'o1' }, target)).toEqual({ id: 'o1' });
  });

  it('leaves a row alone when it carries no key at all', () => {
    const target = resolveCosmosTarget('Order', { Order: { primaryKey: 'orderId' } });
    expect(toDocument({ total: 2 }, target)).toEqual({ total: 2 });
  });
});

describe('documentField', () => {
  it('addresses the mapped primary key as the document id and others verbatim', () => {
    const target = resolveCosmosTarget('Order', { Order: { primaryKey: 'orderId' } });
    expect(documentField('orderId', target)).toBe('id');
    expect(documentField('total', target)).toBe('total');
  });
});

describe('the fake store distinguishes an absent partition key from a null one', () => {
  it('keeps a document with no partition key apart from one carrying null', async () => {
    // They are different partitions to the service, and the non-transactional
    // `create` path forwards a document to `items.create` without requiring a
    // partition key — so collapsing the two hid a real collision.
    const fake = createFakeCosmosClient({ containers: { orders: { partitionKeyPaths: ['/pk'] } } });
    const items = fake.client.database('db').container('orders').items;
    await items.create({ id: 'a', pk: null });
    const second = await items.create({ id: 'a' });
    expect(second.statusCode).toBe(201);
    expect((await fake.client.database('db').container('orders').item('a', null).read()).resource)
      .toMatchObject({ id: 'a', pk: null });
  });
});
