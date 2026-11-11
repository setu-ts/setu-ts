/* eslint-disable require-await -- test fixtures use sync methods matching async interface signatures */
import { describe, expect, it } from 'vitest';

import { requestSizeMiddleware } from '../../src/middleware/request-size-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

describe('requestSizeMiddleware', () => {
  describe('enabled: false', () => {
    it('returns pass-through middleware', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': '999999999' } },
      });
      const mw = requestSizeMiddleware({ enabled: false });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('Content-Length over limit', () => {
    it('returns 413 and does not call next()', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: { headers: { 'Content-Length': '2097152' } },
      });
      const mw = requestSizeMiddleware({ maxBodySize: 1_048_576 });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(413);
      // M70f (X4-8): the rejection converges on the responder's `detail` key.
      const body = response.body as { error: string; detail: string };
      expect(body.error).toBe('Payload Too Large');
      expect(body.detail).toContain('2097152');
      expect(body.detail).toContain('1048576');
    });
  });

  describe('Content-Length at/under limit', () => {
    it('passes through at exact limit', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': '1048576' } },
      });
      const mw = requestSizeMiddleware({ maxBodySize: 1_048_576 });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('passes through under limit', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': '500' } },
      });
      const mw = requestSizeMiddleware({ maxBodySize: 1_048_576 });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('absent Content-Length', () => {
    it('passes through when no Content-Length', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: {} },
      });
      const mw = requestSizeMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('malformed Content-Length', () => {
    // Treated as absent, each of these let a body through unbounded. A correct
    // client sends plain decimal digits only (RFC 9110 §8.6).
    const MALFORMED = [
      'abc',
      '-1',
      'NaN',
      '1.5',
      '1e9',
      '+5',
      '0x10',
      '',
      '   ',
      '5, 5',
      'Infinity',
    ];
    for (const value of MALFORMED) {
      it(`answers 400 without calling next() for ${JSON.stringify(value)}`, async () => {
        const { ctx, nextCalled, response } = createFakeContext({
          request: { headers: { 'Content-Length': value } },
        });
        await requestSizeMiddleware()(ctx, async () => {
          nextCalled.push(true);
        });
        expect(nextCalled).toHaveLength(0);
        expect(response.statuses).toContain(400);
        const body = response.body as { error: string; detail: string };
        expect(body.error).toBe('Bad Request');
        expect(body.detail).toBe('Content-Length must be a non-negative decimal byte count');
      });
    }

    it('accepts surrounding whitespace and leading zeros as a byte count', async () => {
      for (const value of [' 10 ', '0010']) {
        const { ctx, nextCalled } = createFakeContext({
          request: { headers: { 'Content-Length': value } },
        });
        await requestSizeMiddleware()(ctx, async () => {
          nextCalled.push(true);
        });
        expect(nextCalled, value).toHaveLength(1);
      }
    });

    it('answers 413 for a digit string too large to represent', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: { headers: { 'Content-Length': '9'.repeat(400) } },
      });
      await requestSizeMiddleware()(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(413);
    });
  });

  describe('maxBodySize validation', () => {
    // NaN (an unset env var through Number()) and Infinity both disabled the
    // bound silently (security audit finding 1).
    it('refuses a value that is not a non-negative integer at construction', () => {
      for (const maxBodySize of [Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
        expect(() => requestSizeMiddleware({ maxBodySize }), String(maxBodySize)).toThrow(
          /maxBodySize must be a non-negative integer/,
        );
      }
    });
    it('accepts 0 and a disabled middleware with any value', () => {
      expect(() => requestSizeMiddleware({ maxBodySize: 0 })).not.toThrow();
      expect(() =>
        requestSizeMiddleware({ enabled: false, maxBodySize: Number.NaN }),
      ).not.toThrow();
    });
  });

  describe('default maxBodySize', () => {
    it('uses 1 MiB default when maxBodySize omitted', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: { headers: { 'Content-Length': '1048577' } },
      });
      const mw = requestSizeMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(413);
    });

    it('passes at exactly 1 MiB with default', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Content-Length': '1048576' } },
      });
      const mw = requestSizeMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // X32-4 — chunked encoding
  // -------------------------------------------------------------------------

  describe('chunked encoding (X32-4)', () => {
    it('a chunked request reaches next() — this layer CANNOT bound it', async () => {
      // Deliberately asserting the limitation rather than a fix. A chunked
      // request declares no `Content-Length`, so a header check has nothing to
      // read; and since M87 made the body lazy, the read happens inside the
      // handler, AFTER this middleware has already returned. The bound that
      // cannot be bypassed therefore lives where the body is consumed —
      // `RuntimePlugin({ maxBodyBytes })`, asserted in
      // `packages/runtime/test/unit/read-body-bound.test.ts`.
      //
      // `411 Length Required` was rejected as the alternative: it refuses every
      // legitimate streaming upload as the price of closing the bypass.
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'Transfer-Encoding': 'chunked' } },
      });
      const mw = requestSizeMiddleware({ maxBodySize: 10 });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('a DECLARED length is still refused, so the cheap layer keeps working', async () => {
      // The two layers are complementary: this one refuses before a socket is
      // drained, which the read bound cannot do.
      const { ctx, nextCalled, response } = createFakeContext({
        request: { headers: { 'Content-Length': '11' } },
      });
      const mw = requestSizeMiddleware({ maxBodySize: 10 });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(413);
    });
  });
});
