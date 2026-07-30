/**
 * Unit tests for the constant-time comparison.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { timingSafeEqualBytes, timingSafeEqualStrings } from '../../../src/codec/timing-safe.ts';

describe('timingSafeEqualBytes', () => {
  it('accepts identical arrays', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('accepts two empty arrays', () => {
    expect(timingSafeEqualBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('rejects differing lengths without reading past the end', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('rejects same-length differing content, wherever the difference falls', () => {
    expect(timingSafeEqualBytes(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 9, 3]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 9]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('rejects a single-bit difference', () => {
    expect(timingSafeEqualBytes(new Uint8Array([0b0000_0001]), new Uint8Array([0b0000_0000])))
      .toBe(false);
  });

  it('distinguishes the extremes of the byte range', () => {
    expect(timingSafeEqualBytes(new Uint8Array([255]), new Uint8Array([0]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([255]), new Uint8Array([255]))).toBe(true);
  });
});

describe('timingSafeEqualStrings', () => {
  it('accepts identical strings', () => {
    expect(timingSafeEqualStrings('token-abc', 'token-abc')).toBe(true);
  });

  it('rejects different strings', () => {
    expect(timingSafeEqualStrings('token-abc', 'token-abd')).toBe(false);
  });

  it('rejects a prefix', () => {
    expect(timingSafeEqualStrings('token', 'token-extra')).toBe(false);
  });

  it('accepts two empty strings', () => {
    expect(timingSafeEqualStrings('', '')).toBe(true);
  });

  it('compares by UTF-8 bytes, so multi-byte characters are handled', () => {
    expect(timingSafeEqualStrings('café', 'café')).toBe(true);
    expect(timingSafeEqualStrings('café', 'cafe')).toBe(false);
  });
});
