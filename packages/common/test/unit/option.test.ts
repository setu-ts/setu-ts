import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { fromNullable, isNone, isSome, none, some } from '../../src/option.ts';
import type { Option } from '../../src/option.ts';

describe('Option', () => {
  describe('some', () => {
    it('should create an option carrying the value', () => {
      const option = some('value');
      expect(option.present).toBe(true);
      expect(option.value).toBe('value');
    });

    it('should carry falsy values without collapsing to None', () => {
      expect(some(0).present).toBe(true);
      expect(some('').present).toBe(true);
      expect(some(false).present).toBe(true);
      expect(some(undefined).present).toBe(true);
    });
  });

  describe('none', () => {
    it('should create an absent option', () => {
      expect(none().present).toBe(false);
    });

    it('should return a referentially equal singleton', () => {
      expect(none()).toBe(none());
    });

    it('should be frozen', () => {
      expect(Object.isFrozen(none())).toBe(true);
    });
  });

  describe('isSome / isNone', () => {
    it('should narrow Some options', () => {
      const option: Option<number> = some(5);
      expect(isSome(option)).toBe(true);
      expect(isNone(option)).toBe(false);
      if (isSome(option)) {
        expect(option.value).toBe(5);
      }
    });

    it('should narrow None options', () => {
      const option: Option<number> = none();
      expect(isSome(option)).toBe(false);
      expect(isNone(option)).toBe(true);
    });
  });

  describe('fromNullable', () => {
    it('should wrap defined values in Some', () => {
      const option = fromNullable('x');
      expect(option.present).toBe(true);
      expect(isSome(option) && option.value).toBe('x');
    });

    it('should map null to None', () => {
      expect(fromNullable(null).present).toBe(false);
    });

    it('should map undefined to None', () => {
      expect(fromNullable(undefined).present).toBe(false);
    });

    it('should preserve falsy non-nullish values', () => {
      expect(fromNullable(0).present).toBe(true);
      expect(fromNullable('').present).toBe(true);
      expect(fromNullable(false).present).toBe(true);
    });
  });
});
