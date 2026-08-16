/**
 * Unit tests for the `errorHandler` middleware factory.
 *
 * Covers: HttpError passthrough, unknown-error wrapping to 500, logging when
 * a logger is present (and skipped when absent), stack-trace gating, the
 * short-circuit behavior (next not re-invoked, downstream cannot overwrite),
 * and the Problem Details content-type.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NextFunction } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { errorHandler } from '../../src/middleware/error-handler.ts';
import { badRequest, internalServerError, notFound } from '../../src/errors/exceptions.ts';
import { HttpError } from '../../src/errors/http-error.ts';
import { createFakeContext, FakeLogger } from '../fixtures/fake-runtime.ts';
import { rfc7807Formatter } from '../../src/formatters/rfc7807-formatter.ts';
import { rfc9457Formatter } from '../../src/formatters/rfc9457-formatter.ts';

/** Decode the response body (Uint8Array or string) back to a parsed object. */
function parseBody(body: Uint8Array | string | null): Record<string, unknown> {
  if (body === null) return {};
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Creates a next() callback that throws synchronously. */
function nextThrows(error: unknown): NextFunction {
  return () => {
    throw error;
  };
}

/** Creates a next() callback that resolves successfully, optionally with a side effect. */
function nextOk(sideEffect?: () => void): NextFunction {
  return () => {
    if (sideEffect !== undefined) sideEffect();
    return Promise.resolve();
  };
}

describe('errorHandler middleware', () => {
  describe('no error (passthrough)', () => {
    it('calls next and returns undefined when next does not throw', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();
      let nextCalled = false;

      const result = await mw(
        ctx,
        nextOk(() => {
          nextCalled = true;
        }),
      );

      expect(nextCalled).toBe(true);
      expect(result).toBeUndefined();
      expect(responseSnapshot().status).toBe(200);
    });
  });

  describe('HttpError passthrough', () => {
    it('uses the HttpError statusCode', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows(notFound('User not found')));

      expect(responseSnapshot().status).toBe(404);
      const body = parseBody(responseSnapshot().body);
      expect(body.message).toBe('User not found');
      expect(body.statusCode).toBe(404);
    });

    it('uses 400 for badRequest', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows(badRequest('Invalid input')));

      expect(responseSnapshot().status).toBe(400);
    });
  });

  describe('unknown error wrapping', () => {
    it('wraps a generic Error as 500 (masked by default)', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows(new Error('Unexpected database failure')));

      expect(responseSnapshot().status).toBe(500);
      const body = parseBody(responseSnapshot().body);
      // maskInternalErrors defaults to true: the raw message is replaced by
      // the status title so a driver-shaped 500 leaks nothing.
      expect(body.message).toBe('Internal Server Error');
      expect(body.statusCode).toBe(500);
    });

    it('handles a thrown non-Error value', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows('string error'));

      expect(responseSnapshot().status).toBe(500);
      const body = parseBody(responseSnapshot().body);
      expect(body.statusCode).toBe(500);
    });
  });

  describe('maskInternalErrors (X12-3)', () => {
    // A driver-shaped error carrying SQL and bound parameter values — the
    // register's X12-3 reproduction.
    const driverError = () =>
      new Error(
        `PrismaClientKnownRequestError: Failed to load the query \n` +
          `SQL: SELECT * FROM "User" WHERE "email" = 'alice@example.com' AND "role" = 'admin'`,
      );

    it('masks a driver-shaped 500: body carries neither the SQL nor the values', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows(driverError()));

      expect(responseSnapshot().status).toBe(500);
      const body = parseBody(responseSnapshot().body);
      expect(body.message).toBe('Internal Server Error');
      expect(body.message).not.toContain('SELECT');
      expect(body.message).not.toContain('alice@example.com');
      expect(body.message).not.toContain('admin');
    });

    it('still logs the unmasked error (SQL + values) when a logger is present', async () => {
      const logger = new FakeLogger();
      const services = new Map([[CAPABILITIES.LOGGER, logger]]);
      const { ctx } = createFakeContext({ services });
      const mw = errorHandler();

      await mw(ctx, nextThrows(driverError()));

      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].level).toBe('error');
      expect(logger.calls[0].message).toContain('SELECT');
      expect(logger.calls[0].message).toContain('alice@example.com');
    });

    it('never masks a deliberately thrown HttpError 500', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows(internalServerError('Payment gateway timed out')));

      expect(responseSnapshot().status).toBe(500);
      const body = parseBody(responseSnapshot().body);
      // A message the developer chose for the client passes through verbatim.
      expect(body.message).toBe('Payment gateway timed out');
    });

    it('never masks a 4xx HttpError', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows(notFound('User 42 not found')));

      const body = parseBody(responseSnapshot().body);
      expect(body.message).toBe('User 42 not found');
    });

    it('restores the raw message when maskInternalErrors is false', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({ maskInternalErrors: false });

      await mw(ctx, nextThrows(driverError()));

      const body = parseBody(responseSnapshot().body);
      expect(body.message).toContain('SELECT');
      expect(body.message).toContain('alice@example.com');
    });

    // Two entry points, one behavior: the masking must hold under both the
    // default format and the RFC 9457 format, with the non-default masking
    // setting off, so a split between the two formatters cannot hide.
    it('masks under BOTH the default and rfc9457 formats', async () => {
      for (const format of ['default' as const, 'rfc9457' as const]) {
        const { ctx, responseSnapshot } = createFakeContext();
        const mw = errorHandler({ format });

        await mw(ctx, nextThrows(driverError()));

        const body = parseBody(responseSnapshot().body);
        const detail = (body.message ?? body.detail) as string;
        expect(detail).toBe('Internal Server Error');
        expect(detail).not.toContain('SELECT');
        expect(detail).not.toContain('alice@example.com');
      }
    });
  });

  describe('logging', () => {
    it('logs the error when a logger is registered', async () => {
      const logger = new FakeLogger();
      const services = new Map([[CAPABILITIES.LOGGER, logger]]);
      const { ctx } = createFakeContext({ services });
      const mw = errorHandler();

      await mw(ctx, nextThrows(notFound('gone')));

      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].level).toBe('error');
      expect(logger.calls[0].message).toBe('gone');
      expect(logger.calls[0].meta?.statusCode).toBe(404);
    });

    it('includes cause in log metadata when present', async () => {
      const logger = new FakeLogger();
      const services = new Map([[CAPABILITIES.LOGGER, logger]]);
      const { ctx } = createFakeContext({ services });
      const mw = errorHandler();

      const root = new Error('db down');
      await mw(ctx, nextThrows(internalServerError('service failed', root)));

      expect(logger.calls[0].meta?.cause).toBe(root);
    });

    it('does not throw when no logger is registered', async () => {
      const { ctx } = createFakeContext();
      const mw = errorHandler();

      const result = await mw(ctx, nextThrows(notFound('gone')));
      expect(result).toBeDefined();
    });

    it('skips logging when logErrors is false', async () => {
      const logger = new FakeLogger();
      const services = new Map([[CAPABILITIES.LOGGER, logger]]);
      const { ctx } = createFakeContext({ services });
      const mw = errorHandler({ logErrors: false });

      await mw(ctx, nextThrows(notFound('gone')));

      expect(logger.calls).toHaveLength(0);
    });
  });

  describe('stack trace', () => {
    it('omits stack by default', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows(notFound('gone')));

      const body = parseBody(responseSnapshot().body);
      expect('stack' in body).toBe(false);
    });

    it('includes stack when includeStackTrace is true', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({ includeStackTrace: true });

      await mw(ctx, nextThrows(notFound('gone')));

      const body = parseBody(responseSnapshot().body);
      expect(typeof body.stack).toBe('string');
      expect((body.stack as string).length).toBeGreaterThan(0);
    });
  });

  describe('RFC 7807 format', () => {
    it('sets content-type to application/problem+json', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({ format: 'rfc7807' });

      await mw(ctx, nextThrows(notFound('gone')));

      expect(responseSnapshot().headers.get('content-type')).toBe(
        'application/problem+json',
      );
    });

    it('produces RFC 7807 fields (type, title, status, detail) without "message"', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({ format: 'rfc7807' });

      await mw(ctx, nextThrows(notFound('User 42 not found')));

      const body = parseBody(responseSnapshot().body);
      expect(body.type).toBe('https://setu-ts.dev/errors/404');
      expect(body.title).toBe('Not Found');
      expect(body.status).toBe(404);
      expect(body.detail).toBe('User 42 not found');
      expect('message' in body).toBe(false);
    });
  });

  describe('RFC 9457 format', () => {
    it('sets content-type to application/problem+json', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({ format: 'rfc9457' });

      await mw(ctx, nextThrows(notFound('gone')));

      expect(responseSnapshot().headers.get('content-type')).toBe(
        'application/problem+json',
      );
    });

    it('produces RFC 9457 fields with about:blank and without "message"', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({ format: 'rfc9457' });

      await mw(ctx, nextThrows(notFound('User 42 not found')));

      const body = parseBody(responseSnapshot().body);
      expect(body.type).toBe('about:blank');
      expect(body.title).toBe('Not Found');
      expect(body.status).toBe(404);
      expect(body.detail).toBe('User 42 not found');
      expect('message' in body).toBe(false);
    });
  });

  describe('media type is keyed on the RESOLVED formatter', () => {
    // Both formatters are exported, so `format` accepts a reference as well as
    // an alias. Keying the media type on the format STRING would let
    // `format: rfc9457Formatter` emit a Problem Details body as
    // `application/json`, which generic problem-details clients ignore — a
    // silent interoperability defect that a string-only test cannot see.
    const problemDetailsSpellings: ReadonlyArray<
      [string, Parameters<typeof errorHandler>[0]]
    > = [
      ["alias 'rfc9457'", { format: 'rfc9457' }],
      ['reference rfc9457Formatter', { format: rfc9457Formatter }],
      ["deprecated alias 'rfc7807'", { format: 'rfc7807' }],
      ['deprecated reference rfc7807Formatter', { format: rfc7807Formatter }],
    ];

    for (const [label, options] of problemDetailsSpellings) {
      it(`serves problem+json for the ${label}`, async () => {
        const { ctx, responseSnapshot } = createFakeContext();
        const mw = errorHandler(options);

        await mw(ctx, nextThrows(notFound('gone')));

        expect(responseSnapshot().headers.get('content-type')).toBe(
          'application/problem+json',
        );
      });
    }

    it('does NOT serve problem+json for a custom formatter', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({ format: () => ({ oops: true }) });

      await mw(ctx, nextThrows(notFound('gone')));

      expect(responseSnapshot().headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
    });
  });

  describe('default format', () => {
    it('sets content-type to application/json', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({ format: 'default' });

      await mw(ctx, nextThrows(notFound('gone')));

      expect(responseSnapshot().headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
    });
  });

  describe('short-circuit behavior', () => {
    it('returns a HandlerResult and does not re-invoke next after catching', async () => {
      const { ctx } = createFakeContext();
      const mw = errorHandler();

      let nextCallCount = 0;
      const result = await mw(ctx, () => {
        nextCallCount++;
        throw notFound('gone');
      });

      expect(nextCallCount).toBe(1);
      expect(result).toBeDefined();
      expect(result?.__handlerResult).toBe(true);
    });

    it('catches errors thrown from downstream and sets the correct status', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows(new HttpError(409, 'conflict')));

      expect(responseSnapshot().status).toBe(409);
    });
  });

  describe('custom formatter', () => {
    it('uses a custom formatter function', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({
        format: () => ({ custom: true, code: 'ERR_CUSTOM' }),
      });

      await mw(ctx, nextThrows(notFound('gone')));

      const body = parseBody(responseSnapshot().body);
      expect(body.custom).toBe(true);
      expect(body.code).toBe('ERR_CUSTOM');
    });
  });

  // Retro review (Part 3): the content type keyed off the string alias only, so
  // passing the exported formatter itself produced an identical Problem Details
  // body under `application/json`. RFC 7807 §3 requires `application/problem+json`.
  it('serves Problem Details as application/problem+json through BOTH entry points', async () => {
    for (const format of ['rfc7807' as const, rfc7807Formatter]) {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler({ format, logErrors: false });
      await mw(ctx, () => Promise.reject(notFound('nope')));

      const snap = responseSnapshot();
      expect(snap.status).toBe(404);
      expect(snap.headers.get('content-type')).toBe('application/problem+json');
      const body = parseBody(snap.body);
      expect(body.title).toBe('Not Found');
      expect(body.detail).toBe('nope');
      expect('message' in body).toBe(false);
    }
  });
});
