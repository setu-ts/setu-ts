/**
 * Unit tests for the `errorHandler` middleware factory.
 *
 * Covers: HttpError passthrough, unknown-error wrapping to 500, logging when
 * a logger is present (and skipped when absent), stack-trace gating, the
 * short-circuit behavior (next not re-invoked, downstream cannot overwrite),
 * and RFC 7807 content-type.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NextFunction } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { errorHandler } from '../../src/middleware/error-handler.ts';
import { badRequest, internalServerError, notFound } from '../../src/errors/exceptions.ts';
import { HttpError } from '../../src/errors/http-error.ts';
import { createFakeContext, FakeLogger } from '../fixtures/fake-runtime.ts';

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
    it('wraps a generic Error as 500', async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const mw = errorHandler();

      await mw(ctx, nextThrows(new Error('Unexpected database failure')));

      expect(responseSnapshot().status).toBe(500);
      const body = parseBody(responseSnapshot().body);
      expect(body.message).toBe('Unexpected database failure');
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
      expect(body.type).toBe('https://hono-enterprise.dev/errors/404');
      expect(body.title).toBe('Not Found');
      expect(body.status).toBe(404);
      expect(body.detail).toBe('User 42 not found');
      expect('message' in body).toBe(false);
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
});
