/**
 * The Bigtable cell value codec.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { decodeCellValue, encodeCellValue } from '../../src/adapters/bigtable/bigtable-value.ts';

/** Round-trips one value through the tagged encoding. */
function roundTrip(value: unknown): unknown {
  return decodeCellValue(encodeCellValue(value, 'tagged'), 'tagged');
}

describe('tagged cell values', () => {
  it('round-trips every scalar with its type intact', () => {
    expect(roundTrip('ada')).toBe('ada');
    expect(roundTrip('')).toBe('');
    expect(roundTrip(36)).toBe(36);
    expect(roundTrip(-1.5)).toBe(-1.5);
    expect(roundTrip(0)).toBe(0);
    expect(roundTrip(true)).toBe(true);
    expect(roundTrip(false)).toBe(false);
    expect(roundTrip(null)).toBe(null);
  });

  it('round-trips a Date as a Date, not as its ISO string', () => {
    const when = new Date('2026-08-31T10:11:12.000Z');
    const decoded = roundTrip(when);
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).toISOString()).toBe(when.toISOString());
  });

  it('round-trips objects and arrays through the JSON tag', () => {
    expect(roundTrip({ a: 1, b: ['x'] })).toEqual({ a: 1, b: ['x'] });
    expect(roundTrip([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('encodes a value that itself looks like a tag without confusing the decoder', () => {
    expect(roundTrip('n:7')).toBe('n:7');
    expect(roundTrip('z:')).toBe('z:');
  });

  it('decodes an untagged foreign cell as its raw string', () => {
    // A table written outside this framework has no tags at all. Refusing
    // would make it unreadable; this is the documented interop fallback.
    expect(decodeCellValue('london', 'tagged')).toBe('london');
    expect(decodeCellValue('', 'tagged')).toBe('');
  });

  it('falls back to the raw string for a malformed payload rather than throwing', () => {
    expect(decodeCellValue('n:abc', 'tagged')).toBe('n:abc');
    expect(decodeCellValue('n: 1 ', 'tagged')).toBe('n: 1 ');
    expect(decodeCellValue('b:yes', 'tagged')).toBe('b:yes');
    expect(decodeCellValue('d:nope', 'tagged')).toBe('d:nope');
    expect(decodeCellValue('j:{', 'tagged')).toBe('j:{');
  });
});

describe('raw cell values', () => {
  it('writes and reads every value as a string', () => {
    expect(encodeCellValue('ada', 'raw')).toBe('ada');
    expect(encodeCellValue(36, 'raw')).toBe('36');
    expect(encodeCellValue(true, 'raw')).toBe('true');
    expect(encodeCellValue(null, 'raw')).toBe('');
    expect(decodeCellValue('36', 'raw')).toBe('36');
    expect(decodeCellValue('s:36', 'raw')).toBe('s:36');
  });
});
