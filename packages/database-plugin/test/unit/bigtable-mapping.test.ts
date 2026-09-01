/**
 * Mapping resolution for the Bigtable adapter.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  columnAddress,
  resolveBigtableTarget,
  tryColumnAddress,
} from '../../src/adapters/bigtable/bigtable-mapping.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

describe('resolveBigtableTarget', () => {
  it('defaults an unmapped entity to its own name, an id row key and family cf', () => {
    const target = resolveBigtableTarget('User', undefined);
    expect(target.table).toBe('User');
    expect(target.keyFields).toEqual(['id']);
    expect(target.separator).toBe('#');
    expect(target.prefix).toBe('');
    expect(target.defaultFamily).toBe('cf');
    expect(target.valueEncoding).toBe('tagged');
    expect(target.columns).toEqual({});
  });

  it('honours a full mapping', () => {
    const target = resolveBigtableTarget('Order', {
      Order: {
        table: 'orders',
        rowKey: { fields: ['tenantId', 'orderId'], separator: '|', prefix: 'o/' },
        columnFamily: 'o',
        columns: { total: 'metrics:amount', status: 'o' },
        valueEncoding: 'raw',
      },
    });
    expect(target.table).toBe('orders');
    expect(target.keyFields).toEqual(['tenantId', 'orderId']);
    expect(target.separator).toBe('|');
    expect(target.prefix).toBe('o/');
    expect(target.valueEncoding).toBe('raw');
    expect(target.columns.total).toEqual({ family: 'metrics', qualifier: 'amount' });
    // A bare family keeps the field name as the qualifier.
    expect(target.columns.status).toEqual({ family: 'o', qualifier: 'status' });
  });

  it('refuses a blank table, column family or key field by name', () => {
    for (
      const mapping of [
        { User: { table: '  ' } },
        { User: { columnFamily: '' } },
        { User: { rowKey: { fields: [' '] } } },
      ]
    ) {
      expect(() => resolveBigtableTarget('User', mapping)).toThrow(UnsupportedQueryFeatureError);
    }
  });

  it('refuses an empty rowKey.fields', () => {
    expect(() => resolveBigtableTarget('User', { User: { rowKey: { fields: [] } } }))
      .toThrow(/composed from at least one field/);
  });

  it('refuses a multi-field key with an empty separator', () => {
    expect(() =>
      resolveBigtableTarget('User', {
        User: { rowKey: { fields: ['a', 'b'], separator: '' } },
      })
    ).toThrow(/indistinguishable/);
  });

  it('refuses a row-key field whose name cannot be a column qualifier', () => {
    // A key field is always written as a cell, so a name the projection filter
    // cannot address would resolve here and fail at the first write.
    expect(() => resolveBigtableTarget('User', { User: { rowKey: { fields: ['a b'] } } }))
      .toThrow(/not a usable column identifier/);
  });

  it('refuses a family or qualifier carrying a regex metacharacter', () => {
    expect(() => resolveBigtableTarget('User', { User: { columnFamily: 'c.*f' } }))
      .toThrow(/not a usable column identifier/);
    expect(() => resolveBigtableTarget('User', { User: { columns: { a: 'cf:a|b' } } }))
      .toThrow(/not a usable column identifier/);
  });

  it('refuses a column spec carrying more than one colon', () => {
    expect(() => resolveBigtableTarget('User', { User: { columns: { a: 'cf:x:y' } } }))
      .toThrow(/more than one/);
  });

  it('refuses two declared fields sharing one qualifier', () => {
    expect(() =>
      resolveBigtableTarget('User', {
        User: { columns: { first: 'a:name', second: 'b:name' } },
      })
    ).toThrow(/cannot be told apart/);
  });
});

describe('tryColumnAddress', () => {
  it('answers null where columnAddress refuses, and agrees with it otherwise', () => {
    const target = resolveBigtableTarget('User', { User: { columns: { a: 'x:y' } } });
    expect(tryColumnAddress(target, 'a')).toEqual({ family: 'x', qualifier: 'y' });
    expect(tryColumnAddress(target, 'email')).toEqual({ family: 'cf', qualifier: 'email' });
    expect(tryColumnAddress(target, 'not a field')).toBe(null);
  });
});

describe('columnAddress', () => {
  it('falls back to the default family with the field name as qualifier', () => {
    const target = resolveBigtableTarget('User', { User: { columnFamily: 'u' } });
    expect(columnAddress(target, 'email')).toEqual({ family: 'u', qualifier: 'email' });
  });

  it('refuses an unmapped field whose own name is not a usable qualifier', () => {
    const target = resolveBigtableTarget('User', undefined);
    expect(() => columnAddress(target, 'not a field'))
      .toThrow(/not a usable column identifier/);
  });
});
