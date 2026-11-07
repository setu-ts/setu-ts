/**
 * Unit tests for `HttpError`.
 *
 * Covers construction, property assignment, cause chaining via ES2022
 * `Error.cause`, the `name` field, `instanceof`, and the `from()` factory.
 */
import { describe, expect, it } from 'vitest';

import { HTTP_STATUS_HINT, httpStatusHintOf } from '@setu-ts/common';
import { HttpError } from '../../src/errors/http-error.ts';
import {
  badRequest,
  conflict,
  forbidden,
  internalServerError,
  notFound,
  notImplemented,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
  validationError,
} from '../../src/errors/exceptions.ts';

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

describe('HttpError status hint', () => {
  // Each 4xx factory → the hint a package that cannot import this one reads.
  const BRANDED: ReadonlyArray<[HttpError, number, string]> = [
    [badRequest('bad'), 400, 'Bad Request'],
    [unauthorized('who'), 401, 'Unauthorized'],
    [forbidden('no'), 403, 'Forbidden'],
    [notFound('gone'), 404, 'Not Found'],
    [conflict('clash'), 409, 'Conflict'],
    [
      validationError([{ field: 'a', message: 'required' }], 'invalid'),
      422,
      'Unprocessable Entity',
    ],
    [tooManyRequests('slow down'), 429, 'Too Many Requests'],
    [new HttpError(418, 'teapot'), 418, 'Error'],
  ];

  for (const [error, status, title] of BRANDED) {
    it(`brands a ${status} with its status, title and message`, () => {
      expect(httpStatusHintOf(error)).toEqual({ status, title, detail: error.message });
    });
  }

  // A hint promises a caller-safe detail; a server fault's message does not.
  const UNBRANDED: readonly HttpError[] = [
    internalServerError('db password=x'),
    notImplemented('later'),
    serviceUnavailable('down'),
    new HttpError(4004, 'typo'),
    new HttpError(302, 'moved'),
    new HttpError(400.5, 'fraction'),
  ];

  for (const error of UNBRANDED) {
    it(`does not brand a ${error.statusCode}`, () => {
      expect(httpStatusHintOf(error)).toBeUndefined();
    });
  }

  it('keeps the brand out of enumeration and serialization', () => {
    const error = notFound('gone');
    expect(Object.getOwnPropertyDescriptor(error, HTTP_STATUS_HINT)?.enumerable).toBe(false);
    expect(JSON.stringify(error)).not.toContain('Not Found');
  });
});
