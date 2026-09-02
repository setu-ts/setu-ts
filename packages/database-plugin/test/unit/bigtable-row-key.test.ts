/**
 * Row-key composition and parse-back.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolveBigtableTarget } from '../../src/adapters/bigtable/bigtable-mapping.ts';
import {
  compareRowKeys,
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

describe('compareRowKeys', () => {
  it('orders plain ASCII the way JavaScript does', () => {
    expect(compareRowKeys('a', 'b')).toBeLessThan(0);
    expect(compareRowKeys('b', 'a')).toBeGreaterThan(0);
    expect(compareRowKeys('ab', 'ab')).toBe(0);
    expect(compareRowKeys('ab', 'abc')).toBeLessThan(0);
  });

  it('orders a non-BMP key the way UTF-8 does, NOT the way `<` does', () => {
    // `'\u{1F600}' < '\uFF21'` is true in JavaScript — its leading surrogate
    // \uD83D sorts below \uFF21 — and false as UTF-8, where F0 9F 98 80 sorts
    // above EF BC A1. Bigtable sorts row keys as bytes, so the operator is
    // wrong and this comparator is right.
    expect('\u{1F600}y' < '\uFF21x').toBe(true);
    expect(compareRowKeys('\u{1F600}y', '\uFF21x')).toBeGreaterThan(0);
  });
});

describe('prefixSuccessor', () => {
  it('increments the final code point', () => {
    expect(prefixSuccessor('u#')).toBe('u$');
    expect(prefixSuccessor('az')).toBe('a{');
  });

  it('steps from the last BMP code point into the astral plane, not over it', () => {
    // Incrementing the final code UNIT would carry to `'b'` here, skipping
    // every non-BMP key that genuinely sorts between `a\uFFFF` and `b`.
    expect(prefixSuccessor('a\uFFFF')).toBe(`a${String.fromCodePoint(0x10000)}`);
  });

  it('skips the surrogate range rather than minting an unencodable key', () => {
    expect(prefixSuccessor('a\uD7FF')).toBe('a\uE000');
  });

  it('carries past a lone surrogate and past the maximum code point', () => {
    expect(prefixSuccessor(`a\uD800`)).toBe('b');
    expect(prefixSuccessor(`a${String.fromCodePoint(0x10ffff)}`)).toBe('b');
  });

  it('has no successor for an empty prefix or an all-maximum one', () => {
    expect(prefixSuccessor('')).toBeUndefined();
    const max = String.fromCodePoint(0x10ffff);
    expect(prefixSuccessor(`${max}${max}`)).toBeUndefined();
  });
});
