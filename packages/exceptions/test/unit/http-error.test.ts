/**
 * Unit tests for `HttpError`.
 *
 * Covers construction, property assignment, cause chaining via ES2022
 * `Error.cause`, the `name` field, `instanceof`, and the `from()` factory.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { HttpError } from '../../src/errors/http-error.ts';

describe('HttpError', () => {
  describe('construction', () => {
    it('sets statusCode, message, and name', () => {
      const err = new HttpError(404, 'Not Found');
      expect(err.statusCode).toBe(404);
      expect(err.message).toBe('Not Found');
      expect(err.name).toBe('HttpError');
    });

    it('omits details when not provided (exactOptionalPropertyTypes)', () => {
      const err = new HttpError(400, 'Bad Request');
      expect('details' in err).toBe(false);
      expect(err.details).toBeUndefined();
    });

    it('sets details when provided', () => {
      const details = { field: 'email', issue: 'required' };
      const err = new HttpError(422, 'Validation failed', details);
      expect(err.details).toEqual(details);
    });

    it('omits cause when not provided', () => {
      const err = new HttpError(500, 'Server error');
      expect(err.cause).toBeUndefined();
    });

    it('forwards cause to the ES2022 Error cause chain', () => {
      const original = new Error('database down');
      const err = new HttpError(500, 'Server error', undefined, original);
      expect(err.cause).toBe(original);
    });

    it('accepts both details and cause', () => {
      const original = new TypeError('bad type');
      const details = { hint: 'expected string' };
      const err = new HttpError(400, 'Bad input', details, original);
      expect(err.details).toEqual(details);
      expect(err.cause).toBe(original);
    });
  });

  describe('inheritance', () => {
    it('is an instance of Error', () => {
      const err = new HttpError(404, 'Not Found');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(HttpError);
    });

    it('has a stack trace', () => {
      const err = new HttpError(500, 'boom');
      expect(typeof err.stack).toBe('string');
      expect(err.stack).toContain('HttpError');
    });
  });

  describe('from()', () => {
    it('creates an HttpError from an HttpErrorInit object', () => {
      const original = new Error('root cause');
      const err = HttpError.from({
        statusCode: 500,
        message: 'wrapped',
        details: { retry: true },
        cause: original,
      });
      expect(err.statusCode).toBe(500);
      expect(err.message).toBe('wrapped');
      expect(err.details).toEqual({ retry: true });
      expect(err.cause).toBe(original);
    });

    it('omits details and cause when absent', () => {
      const err = HttpError.from({ statusCode: 404, message: 'gone' });
      expect(err.details).toBeUndefined();
      expect(err.cause).toBeUndefined();
    });
  });
});
