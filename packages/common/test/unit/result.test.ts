import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { err, isErr, isOk, ok, unwrap } from '../../src/result.ts';
import type { Result } from '../../src/result.ts';

describe('Result', () => {
  describe('ok', () => {
    it('should create a successful result carrying the value', () => {
      const result = ok(42);
      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
    });
  });

  describe('err', () => {
    it('should create a failed result carrying the error', () => {
      const error = new Error('boom');
      const result = err(error);
      expect(result.success).toBe(false);
      expect(result.error).toBe(error);
    });

    it('should carry non-Error error types', () => {
      const result = err({ code: 'VALIDATION', issues: [] });
      expect(result.error.code).toBe('VALIDATION');
    });
  });

  describe('isOk / isErr', () => {
    it('should narrow Ok results', () => {
      const result: Result<number, Error> = ok(1);
      expect(isOk(result)).toBe(true);
      expect(isErr(result)).toBe(false);
      if (isOk(result)) {
        expect(result.value).toBe(1);
      }
    });

    it('should narrow Err results', () => {
      const result: Result<number, Error> = err(new Error('boom'));
      expect(isOk(result)).toBe(false);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toBe('boom');
      }
    });
  });

  describe('unwrap', () => {
    it('should return the value of an Ok result', () => {
      expect(unwrap(ok('hello'))).toBe('hello');
    });

    it('should throw the error of an Err result', () => {
      const error = new Error('boom');
      expect(() => unwrap(err(error))).toThrow('boom');
    });
  });

  describe('discriminant narrowing', () => {
    it('should narrow via the success property', () => {
      const parse = (raw: string): Result<number, RangeError> => {
        const value = Number(raw);
        return Number.isFinite(value) ? ok(value) : err(new RangeError(`bad: ${raw}`));
      };

      const good = parse('3');
      const bad = parse('x');
      expect(good.success && good.value).toBe(3);
      expect(!bad.success && bad.error).toBeInstanceOf(RangeError);
    });
  });
});
