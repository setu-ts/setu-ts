/**
 * Tests for {@linkcode hasMethods} — structural shape validation.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { hasMethods } from '../../src/providers/shape.ts';

describe('hasMethods', () => {
  it('returns true for an object with all required methods', () => {
    const obj = {
      foo: (): void => {},
      bar: (): void => {},
    };
    expect(hasMethods(obj, ['foo', 'bar'])).toBe(true);
  });

  it('returns false for null', () => {
    expect(hasMethods(null, ['foo'])).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasMethods(undefined, ['foo'])).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(hasMethods('string', ['foo'])).toBe(false);
    expect(hasMethods(42, ['foo'])).toBe(false);
    expect(hasMethods([], ['foo'])).toBe(false);
  });

  it('returns false when a required method is missing', () => {
    const obj = {
      foo: (): void => {},
    };
    expect(hasMethods(obj, ['foo', 'bar'])).toBe(false);
  });

  it('returns false when a required method is not a function', () => {
    const obj = {
      foo: (): void => {},
      bar: 'not-a-function',
    };
    expect(hasMethods(obj, ['foo', 'bar'])).toBe(false);
  });
});
