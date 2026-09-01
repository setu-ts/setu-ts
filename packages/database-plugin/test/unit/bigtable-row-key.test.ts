/**
 * Row-key composition and parse-back.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolveBigtableTarget } from '../../src/adapters/bigtable/bigtable-mapping.ts';
import {
  composeRowKey,
  composeRowKeyFromFields,
  parseRowKey,
  prefixSuccessor,
} from '../../src/adapters/bigtable/bigtable-row-key.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';

const scalar = resolveBigtableTarget('User', undefined);
const composite = resolveBigtableTarget('Order', {
  Order: { rowKey: { fields: ['tenantId', 'orderId'], prefix: 'o/' } },
});

describe('composeRowKey', () => {
  it('renders a scalar key for a single-field row key', () => {
    expect(composeRowKey(scalar, 'u1', 'findById')).toBe('u1');
    expect(composeRowKey(scalar, 7, 'findById')).toBe('7');
  });

  it('renders a record key for a single-field row key', () => {
    expect(composeRowKey(scalar, { id: 'u1' }, 'findById')).toBe('u1');
  });

  it('composes a multi-field key with the prefix and separator', () => {
    expect(composeRowKey(composite, { tenantId: 't1', orderId: 'o9' }, 'findById'))
      .toBe('o/t1#o9');
  });

  it('refuses a scalar against a multi-field row key by name', () => {
    expect(() => composeRowKey(composite, 'o9', 'findById'))
      .toThrow(/needs a record naming every field/);
  });

  it('refuses a record missing one key field', () => {
    expect(() => composeRowKey(composite, { tenantId: 't1' }, 'findById'))
      .toThrow(/'orderId' is missing/);
  });

  it('refuses a value containing the separator, because two keys would collide', () => {
    expect(() => composeRowKey(composite, { tenantId: 't#1', orderId: 'o9' }, 'create'))
      .toThrow(/contains the '#' separator/);
  });

  it('allows a separator character in a SINGLE-field key, where nothing can collide', () => {
    expect(composeRowKey(scalar, 'a#b', 'findById')).toBe('a#b');
  });

  it('refuses a non-scalar or non-finite key segment', () => {
    // Driven through the exported entry point rather than the private renderer,
    // so the refusals asserted here are the ones a caller can actually reach.
    expect(() => composeRowKeyFromFields(scalar, { id: {} }, 'create'))
      .toThrow(UnsupportedQueryFeatureError);
    expect(() => composeRowKeyFromFields(scalar, { id: Number.NaN }, 'create'))
      .toThrow(/NaN or Infinity/);
    expect(() => composeRowKeyFromFields(scalar, { id: null }, 'create'))
      .toThrow(/is missing from the key/);
    expect(() => composeRowKeyFromFields(scalar, {}, 'create'))
      .toThrow(/is missing from the key/);
  });
});

describe('composeRowKeyFromFields', () => {
  it('reads the key fields out of a data payload', () => {
    expect(
      composeRowKeyFromFields(composite, { tenantId: 't1', orderId: 'o1', total: 5 }, 'create'),
    )
      .toBe('o/t1#o1');
  });
});

describe('parseRowKey', () => {
  it('recovers a single-field key', () => {
    expect(parseRowKey(scalar, 'u1')).toEqual({ id: 'u1' });
  });

  it('recovers a composed key, prefix stripped', () => {
    expect(parseRowKey(composite, 'o/t1#o9')).toEqual({ tenantId: 't1', orderId: 'o9' });
  });

  it('recovers nothing from a key whose prefix or shape disagrees', () => {
    expect(parseRowKey(composite, 'x/t1#o9')).toEqual({});
    expect(parseRowKey(composite, 'o/t1#o9#extra')).toEqual({});
  });
});

describe('prefixSuccessor', () => {
  it('increments the final code unit', () => {
    expect(prefixSuccessor('u#')).toBe('u$');
    expect(prefixSuccessor('az')).toBe('a{');
  });

  it('carries when the final code unit is already the maximum', () => {
    expect(prefixSuccessor(`a￿`)).toBe('b');
  });

  it('has no successor for an empty prefix or an all-maximum one', () => {
    expect(prefixSuccessor('')).toBeUndefined();
    expect(prefixSuccessor('￿￿')).toBeUndefined();
  });
});
