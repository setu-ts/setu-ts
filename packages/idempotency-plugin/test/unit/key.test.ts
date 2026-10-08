/**
 * Unit tests for client-key normalization (plan §3.6).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseKeyValue } from '../../src/core/key.ts';

describe('parseKeyValue (M109a §3.6)', () => {
  it('accepts a bare key', () => {
    expect(parseKeyValue('abc-123')).toBe('abc-123');
  });

  it('strips one pair of Structured-Field double quotes', () => {
    expect(parseKeyValue('"abc"')).toBe('abc');
  });

  it('accepts 255 characters and refuses 256', () => {
    expect(parseKeyValue('a'.repeat(255))).toBe('a'.repeat(255));
    expect(parseKeyValue('a'.repeat(256))).toBeUndefined();
  });

  it('refuses the empty string', () => {
    expect(parseKeyValue('')).toBeUndefined();
    expect(parseKeyValue('""')).toBeUndefined();
  });

  it('refuses a space, a quote, DEL and a non-ASCII character', () => {
    expect(parseKeyValue('a b')).toBeUndefined();
    expect(parseKeyValue('a"b')).toBeUndefined();
    expect(parseKeyValue(`a\u007fb`)).toBeUndefined();
    expect(parseKeyValue('café')).toBeUndefined();
  });

  it('refuses a control character', () => {
    expect(parseKeyValue(`a\u0001b`)).toBeUndefined();
  });
});
