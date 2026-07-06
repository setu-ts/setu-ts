/**
 * Unit tests for the RFC 7807 Problem Details formatter.
 *
 * Asserts the output conforms to RFC 7807 **field-by-field**: required fields
 * present, forbidden fields (`message`) absent, `instance` derived from the
 * request path, and the `errors` extension for validation failures.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ERROR_TYPE_BASE, rfc7807Formatter } from '../../src/formatters/rfc7807-formatter.ts';
import { HttpError } from '../../src/errors/http-error.ts';
import { internalServerError, notFound, validationError } from '../../src/errors/exceptions.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

describe('rfc7807Formatter', () => {
  describe('with an HttpError', () => {
    it('includes required RFC 7807 fields', () => {
      const error = notFound('User 123 not found');
      const body = rfc7807Formatter(error);

      expect(body.type).toBe(`${ERROR_TYPE_BASE}/404`);
      expect(body.title).toBe('Not Found');
      expect(body.status).toBe(404);
      expect(body.detail).toBe('User 123 not found');
    });

    it('does NOT include "message" (RFC 7807 uses "detail")', () => {
      const error = notFound('gone');
      const body = rfc7807Formatter(error);
      expect('message' in body).toBe(false);
    });

    it('derives type URI from the status code', () => {
      const error = internalServerError('boom');
      const body = rfc7807Formatter(error);
      expect(body.type).toBe(`${ERROR_TYPE_BASE}/500`);
    });

    it('derives title from the status code', () => {
      const error = new HttpError(429, 'rate limited');
      const body = rfc7807Formatter(error);
      expect(body.title).toBe('Too Many Requests');
      expect(body.status).toBe(429);
    });
  });

  describe('with a generic Error', () => {
    it('defaults status to 500', () => {
      const body = rfc7807Formatter(new Error('unexpected'));
      expect(body.status).toBe(500);
      expect(body.title).toBe('Internal Server Error');
    });

    it('uses the error message as detail', () => {
      const body = rfc7807Formatter(new Error('something broke'));
      expect(body.detail).toBe('something broke');
    });

    it('does NOT include "message"', () => {
      const body = rfc7807Formatter(new Error('x'));
      expect('message' in body).toBe(false);
    });
  });

  describe('instance field', () => {
    it('includes instance from ctx.request.path when ctx is provided', () => {
      const error = notFound('not here');
      const { ctx } = createFakeContext({ request: { path: '/users/123' } });
      const body = rfc7807Formatter(error, ctx);
      expect(body.instance).toBe('/users/123');
    });

    it('omits instance when ctx is not provided', () => {
      const error = notFound('not here');
      const body = rfc7807Formatter(error);
      expect('instance' in body).toBe(false);
    });
  });

  describe('errors extension', () => {
    it('includes errors for validation errors (422)', () => {
      const error = validationError([
        { field: 'email', message: 'Invalid email', code: 'invalid_type' },
        { field: 'age', message: 'Must be positive' },
      ]);
      const body = rfc7807Formatter(error);

      expect(body.errors).toBeDefined();
      expect(body.errors).toHaveLength(2);
      expect(body.errors).toEqual([
        { field: 'email', message: 'Invalid email', code: 'invalid_type' },
        { field: 'age', message: 'Must be positive' },
      ]);
    });

    it('omits errors when the HttpError has no validation details', () => {
      const error = notFound('gone');
      const body = rfc7807Formatter(error);
      expect('errors' in body).toBe(false);
    });

    it('omits errors for generic Errors', () => {
      const body = rfc7807Formatter(new Error('x'));
      expect('errors' in body).toBe(false);
    });
  });
});
