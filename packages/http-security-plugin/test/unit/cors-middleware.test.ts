// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { corsMiddleware } from '../../src/middleware/cors-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

describe('corsMiddleware', () => {
  describe('enabled: false', () => {
    it('returns pass-through middleware', async () => {
      const { ctx, nextCalled } = createFakeContext();
      const mw = corsMiddleware({ enabled: false });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('origin matching', () => {
    it('origin: true reflects request origin', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({ origin: true });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com');
      const vary = response.appendedHeaders.get('vary');
      expect(Array.isArray(vary) && vary.includes('Origin')).toBe(true);
    });

    it('origin: false denies all', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({ origin: false });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
    });

    it('string origin allows matching origin', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({ origin: 'https://example.com' });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com');
    });

    it('string origin denies non-matching origin', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = corsMiddleware({ origin: 'https://example.com' });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
    });

    it('array origin allows any matching origin', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://app.example.com' },
        },
      });
      const mw = corsMiddleware({ origin: ['https://example.com', 'https://app.example.com'] });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    });

    it('array origin denies non-matching origin', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = corsMiddleware({ origin: ['https://example.com'] });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
    });

    it('fn origin returns true reflects origin', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({
        origin: (origin) => origin === 'https://example.com',
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com');
    });

    it('fn origin returns string uses that string', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({
        origin: () => 'https://proxy.example.com',
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://proxy.example.com');
    });

    it('async fn origin works', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({
        origin: async (origin) => origin === 'https://example.com',
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com');
    });
  });

  describe('credentials', () => {
    it('credentials: true sets Allow-Credentials header', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({ origin: 'https://example.com', credentials: true });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('credentials: true reflects specific origin (never *)', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({ origin: true, credentials: true });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com');
      expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
    });
  });

  describe('preflight (OPTIONS)', () => {
    it('allowed preflight returns 204 short-circuit', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://example.com',
            'Access-Control-Request-Method': 'POST',
          },
        },
      });
      const mw = corsMiddleware({ origin: 'https://example.com' });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com');
      const varyValues = response.appendedHeaders.get('vary');
      expect(Array.isArray(varyValues) && varyValues.includes('Origin')).toBe(true);
    });

    it('preflight sets Allow-Methods and Allow-Headers', async () => {
      const { ctx, response } = createFakeContext({
        request: {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://example.com',
            'Access-Control-Request-Method': 'POST',
          },
        },
      });
      const mw = corsMiddleware({
        origin: 'https://example.com',
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        maxAge: 86400,
      });
      await mw(ctx, async () => {});
      expect(response.headers.get('allow-methods')).toBe('GET, POST');
      expect(response.headers.get('allow-headers')).toBe('Content-Type, Authorization');
      expect(response.headers.get('max-age')).toBe('86400');
    });

    it('disallowed preflight returns 204 with no CORS headers', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://evil.com',
            'Access-Control-Request-Method': 'POST',
          },
        },
      });
      const mw = corsMiddleware({ origin: 'https://example.com' });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(204);
      expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
    });
  });

  describe('no Origin header', () => {
    it('passes through without CORS headers', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: { method: 'GET' },
      });
      const mw = corsMiddleware({ origin: 'https://example.com' });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
    });
  });

  describe('default options', () => {
    it('empty options defaults to deny all cross-origin', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
    });
  });

  describe('exposedHeaders', () => {
    it('sets Access-Control-Expose-Headers when configured', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({
        origin: 'https://example.com',
        exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining'],
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-expose-headers')).toBe(
        'X-Request-Id, X-RateLimit-Remaining',
      );
    });
  });

  describe('Vary header', () => {
    it('appends Origin to Vary', async () => {
      const { ctx, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({ origin: 'https://example.com' });
      await mw(ctx, async () => {});
      const varyValues = response.appendedHeaders.get('vary');
      expect(varyValues).toContain('Origin');
    });
  });
});
