/**
 * Unit tests for exception factory functions.
 *
 * Asserts each factory returns an `HttpError` with the correct `statusCode`
 * and that `validationError` packs its errors into `details`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  badRequest,
  conflict,
  forbidden,
  internalServerError,
  notFound,
  notImplemented,
  serviceUnavailable,
  STATUS_TITLES,
  statusTitle,
  tooManyRequests,
  unauthorized,
  validationError,
} from '../../src/errors/exceptions.ts';
import { HttpError } from '../../src/errors/http-error.ts';

describe('exception factories', () => {
  describe('status code mapping', () => {
    it('badRequest → 400', () => {
      expect(badRequest('nope').statusCode).toBe(400);
    });
    it('unauthorized → 401', () => {
      expect(unauthorized('nope').statusCode).toBe(401);
    });
    it('forbidden → 403', () => {
      expect(forbidden('nope').statusCode).toBe(403);
    });
    it('notFound → 404', () => {
      expect(notFound('nope').statusCode).toBe(404);
    });
    it('conflict → 409', () => {
      expect(conflict('nope').statusCode).toBe(409);
    });
    it('validationError → 422', () => {
      expect(validationError([]).statusCode).toBe(422);
    });
    it('tooManyRequests → 429', () => {
      expect(tooManyRequests('slow down').statusCode).toBe(429);
    });
    it('internalServerError → 500', () => {
      expect(internalServerError('boom').statusCode).toBe(500);
    });
    it('notImplemented → 501', () => {
      expect(notImplemented('todo').statusCode).toBe(501);
    });
    it('serviceUnavailable → 503', () => {
      expect(serviceUnavailable('down').statusCode).toBe(503);
    });
  });

  describe('return type', () => {
    it('all factories return HttpError instances', () => {
      const errors: HttpError[] = [
        badRequest('x'),
        unauthorized('x'),
        forbidden('x'),
        notFound('x'),
        conflict('x'),
        tooManyRequests('x'),
        internalServerError('x'),
        notImplemented('x'),
        serviceUnavailable('x'),
      ];
      for (const err of errors) {
        expect(err).toBeInstanceOf(HttpError);
        expect(err.message).toBe('x');
      }
    });

    it('validationError returns an HttpError with a count-based message', () => {
      const err = validationError([{ field: 'a', message: 'x' }]);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.message).toBe('Validation failed with 1 error(s).');
    });
  });

  describe('badRequest with details', () => {
    it('includes details when provided', () => {
      const err = badRequest('invalid', { field: 'email' });
      expect(err.details).toEqual({ field: 'email' });
    });

    it('omits details when not provided', () => {
      const err = badRequest('invalid');
      expect(err.details).toBeUndefined();
    });
  });

  describe('tooManyRequests with details', () => {
    it('includes details when provided', () => {
      const err = tooManyRequests('rate limited', { retryAfter: 60 });
      expect(err.details).toEqual({ retryAfter: 60 });
    });
  });

  describe('validationError', () => {
    it('packs errors into details.errors', () => {
      const errors = [
        { field: 'email', message: 'Invalid email', code: 'invalid_type' },
        { field: 'age', message: 'Must be positive' },
      ];
      const err = validationError(errors);
      expect(err.details).toEqual({ errors });
    });

    it('uses a count-based summary message by default', () => {
      const err = validationError([
        { field: 'a', message: 'x' },
        { field: 'b', message: 'y' },
        { field: 'c', message: 'z' },
      ]);
      expect(err.message).toBe('Validation failed with 3 error(s).');
    });

    it('accepts a custom message', () => {
      const err = validationError(
        [{ field: 'a', message: 'x' }],
        'Custom validation message',
      );
      expect(err.message).toBe('Custom validation message');
    });
  });

  describe('internalServerError with cause', () => {
    it('forwards cause to the error chain', () => {
      const original = new Error('db connection failed');
      const err = internalServerError('Service unavailable', original);
      expect(err.cause).toBe(original);
    });

    it('omits cause when not provided', () => {
      const err = internalServerError('Something broke');
      expect(err.cause).toBeUndefined();
    });
  });
});

describe('statusTitle', () => {
  it('returns the documented title for known codes', () => {
    expect(statusTitle(400)).toBe('Bad Request');
    expect(statusTitle(401)).toBe('Unauthorized');
    expect(statusTitle(403)).toBe('Forbidden');
    expect(statusTitle(404)).toBe('Not Found');
    expect(statusTitle(409)).toBe('Conflict');
    expect(statusTitle(422)).toBe('Unprocessable Entity');
    expect(statusTitle(429)).toBe('Too Many Requests');
    expect(statusTitle(500)).toBe('Internal Server Error');
    expect(statusTitle(503)).toBe('Service Unavailable');
  });

  it('falls back to "Error" for unknown codes', () => {
    expect(statusTitle(418)).toBe('Error');
  });

  it('STATUS_TITLES is a readonly record of known codes', () => {
    expect(STATUS_TITLES[404]).toBe('Not Found');
    expect(Object.keys(STATUS_TITLES).length).toBeGreaterThan(0);
  });
});
