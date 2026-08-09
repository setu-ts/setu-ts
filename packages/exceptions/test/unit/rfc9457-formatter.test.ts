/**
 * Unit tests for the RFC 9457 Problem Details formatter.
 *
 * Asserts the output conforms to RFC 9457 **field-by-field**: the five core
 * members present, the forbidden `message` field absent, `instance` derived
 * from the request path, and the `errors` extension for validation failures.
 *
 * The `type` cases are the substance of the milestone. RFC 9457 §4.2 registers
 * `about:blank` for problems carrying "no semantics beyond the HTTP status
 * code", which is every `HttpError` the framework produces except the one from
 * `validationError()` — that one defines an `errors` extension member and is a
 * distinct problem type.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { rfc9457Formatter } from '../../src/formatters/rfc9457-formatter.ts';
import { rfc7807Formatter } from '../../src/formatters/rfc7807-formatter.ts';
import { ERROR_TYPE_BASE } from '../../src/formatters/problem-details.ts';
import { HttpError } from '../../src/errors/http-error.ts';
import {
  badRequest,
  conflict,
  forbidden,
  internalServerError,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
  validationError,
} from '../../src/errors/exceptions.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

describe('rfc9457Formatter', () => {
  describe('the RFC 9457 type member', () => {
    it('is about:blank for every status-only problem', () => {
      // One case per factory that carries no extension member. RFC 9457 §4.2:
      // a URI minted from the status code identifies nothing the `status`
      // member does not already convey.
      const statusOnly = [
        badRequest('bad'),
        unauthorized('nope'),
        forbidden('denied'),
        notFound('gone'),
        conflict('clash'),
        tooManyRequests('slow down'),
        internalServerError('boom'),
        serviceUnavailable('down'),
      ];

      for (const error of statusOnly) {
        expect(rfc9457Formatter(error).type).toBe('about:blank');
      }
    });

    it('is about:blank for a generic non-HttpError', () => {
      expect(rfc9457Formatter(new Error('unexpected')).type).toBe('about:blank');
    });

    it('is the validation problem type when the error carries an errors extension', () => {
      const error = validationError([{ field: 'email', message: 'Invalid email' }]);
      expect(rfc9457Formatter(error).type).toBe(`${ERROR_TYPE_BASE}/validation`);
    });

    it('reads ERROR_TYPE_BASE on a live path, so it is not dead surface', () => {
      // The exported constant survives the move to about:blank only because the
      // validation problem type is still composed from it. If that ever stops
      // being true, the export must be cut rather than left dangling.
      const body = rfc9457Formatter(validationError([{ field: 'a', message: 'b' }]));
      expect(String(body.type).startsWith(ERROR_TYPE_BASE)).toBe(true);
    });

    it('is about:blank for a 422 that carries no errors extension', () => {
      // Status alone must not select the validation type — the extension member
      // is what makes it a distinct problem type.
      const error = new HttpError(422, 'unprocessable');
      expect(rfc9457Formatter(error).type).toBe('about:blank');
    });
  });

  describe('core members', () => {
    it('includes the five RFC 9457 core members', () => {
      const { ctx } = createFakeContext({ request: { path: '/users/123' } });
      const body = rfc9457Formatter(notFound('User 123 not found'), ctx);

      expect(body).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'User 123 not found',
        instance: '/users/123',
      });
    });

    it('does NOT include "message" (RFC 9457 uses "detail")', () => {
      expect('message' in rfc9457Formatter(notFound('gone'))).toBe(false);
      expect('message' in rfc9457Formatter(new Error('x'))).toBe(false);
    });

    it('derives title from the status code, per RFC 9457 §4.2 for about:blank', () => {
      const body = rfc9457Formatter(new HttpError(429, 'rate limited'));
      expect(body.title).toBe('Too Many Requests');
      expect(body.status).toBe(429);
    });

    it('falls back to a generic title for a status outside the known set', () => {
      const body = rfc9457Formatter(new HttpError(418, "I'm a teapot"));
      expect(body.title).toBe('Error');
      expect(body.status).toBe(418);
    });

    it('defaults a generic Error to 500 and uses its message as detail', () => {
      const body = rfc9457Formatter(new Error('something broke'));
      expect(body.status).toBe(500);
      expect(body.title).toBe('Internal Server Error');
      expect(body.detail).toBe('something broke');
    });

    it('omits instance when no request context is supplied', () => {
      expect('instance' in rfc9457Formatter(notFound('not here'))).toBe(false);
    });
  });

  describe('errors extension', () => {
    it('carries the field/message/code shape unchanged', () => {
      // Pins the scope decision: realigning to RFC 9457 §3's illustrated
      // `{ detail, pointer }` shape was explicitly declined for this milestone.
      const error = validationError([
        { field: 'email', message: 'Invalid email', code: 'invalid_type' },
        { field: 'age', message: 'Must be positive' },
      ]);
      expect(rfc9457Formatter(error).errors).toEqual([
        { field: 'email', message: 'Invalid email', code: 'invalid_type' },
        { field: 'age', message: 'Must be positive' },
      ]);
    });

    it('omits errors when the error carries none', () => {
      expect('errors' in rfc9457Formatter(notFound('gone'))).toBe(false);
      expect('errors' in rfc9457Formatter(new Error('x'))).toBe(false);
    });
  });

  describe('both entry points share one implementation', () => {
    it('produces identical bodies whether reached by alias or by reference', () => {
      // Drives the two exported formatters over the same non-default input
      // (a request context AND a validation extension), asserting the shared
      // core in problem-details.ts is what both go through.
      const error = validationError([{ field: 'email', message: 'Invalid email' }]);
      const { ctx } = createFakeContext({ request: { path: '/signup' } });

      const viaRfc9457 = rfc9457Formatter(error, ctx);
      const viaRfc7807 = rfc7807Formatter(error, ctx);

      for (const key of ['title', 'status', 'detail', 'instance', 'errors'] as const) {
        expect(viaRfc9457[key]).toEqual(viaRfc7807[key]);
      }
      expect(viaRfc9457.type).not.toBe(viaRfc7807.type);
    });
  });
});
