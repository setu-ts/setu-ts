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

    it('credentials: true echoes the configured origin (never *)', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        },
      });
      const mw = corsMiddleware({ origin: ['https://example.com'], credentials: true });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com');
      expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('refuses `origin: true` combined with credentials at construction time', () => {
      // Reflecting an arbitrary Origin while allowing credentials lets any site
      // the user visits read credentialed responses — the reflected concrete
      // origin sidesteps the browser's `*`-with-credentials prohibition.
      expect(() => corsMiddleware({ origin: true, credentials: true })).toThrow(
        /cannot be combined with/,
      );
    });

    it('still allows `origin: true` without credentials', async () => {
      const { ctx, response } = createFakeContext({
        request: { method: 'GET', headers: { Origin: 'https://anywhere.test' } },
      });
      const mw = corsMiddleware({ origin: true });
      await mw(ctx, async () => {});
      expect(response.headers.get('access-control-allow-origin')).toBe('https://anywhere.test');
      // The fixture records headers in a Map, so an unset header is `undefined`.
      expect(response.headers.get('access-control-allow-credentials')).toBeUndefined();
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

    it('preflight sets Access-Control-Allow-Methods and Access-Control-Allow-Headers', async () => {
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
      expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST');
      expect(response.headers.get('access-control-allow-headers')).toBe(
        'Content-Type, Authorization',
      );
      expect(response.headers.get('access-control-max-age')).toBe('86400');
      // The short forms are NOT real CORS headers and must not be emitted
      expect(response.headers.get('allow-methods')).toBeUndefined();
      expect(response.headers.get('allow-headers')).toBeUndefined();
      expect(response.headers.get('max-age')).toBeUndefined();
    });

    describe('allowedHeaders default — echo (M70m/X11-3)', () => {
      function preflight(requested?: string) {
        return createFakeContext({
          request: {
            method: 'OPTIONS',
            headers: {
              Origin: 'https://example.com',
              'Access-Control-Request-Method': 'POST',
              ...(requested === undefined ? {} : { 'Access-Control-Request-Headers': requested }),
            },
          },
        });
      }

      it('echoes Access-Control-Request-Headers when none is configured', async () => {
        // The defect: `allowedHeaders` defaulted to `[]` while `methods`
        // defaulted to every standard verb, so the preflight advertised POST
        // and then refused `content-type` — every browser blocked every JSON
        // request made against the README's own example.
        const { ctx, response } = preflight('content-type');
        await corsMiddleware({ origin: 'https://example.com' })(ctx, async () => {});

        expect(response.headers.get('access-control-allow-headers')).toBe('content-type');
      });

      it('echoes a multi-header request verbatim', async () => {
        const { ctx, response } = preflight('content-type, x-request-id');
        await corsMiddleware({ origin: 'https://example.com' })(ctx, async () => {});

        expect(response.headers.get('access-control-allow-headers')).toBe(
          'content-type, x-request-id',
        );
      });

      it('appends Vary: Access-Control-Request-Headers when echoing', async () => {
        // Mandatory, not decorative: the answer now depends on this request
        // header, so without it a shared cache can serve one caller's
        // preflight response to a caller asking for different headers.
        const { ctx, response } = preflight('content-type');
        await corsMiddleware({ origin: 'https://example.com' })(ctx, async () => {});

        const vary = response.appendedHeaders.get('vary');
        expect(Array.isArray(vary) && vary.includes('Access-Control-Request-Headers')).toBe(true);
      });

      it('emits no Allow-Headers when the preflight requests none', async () => {
        const { ctx, response } = preflight();
        await corsMiddleware({ origin: 'https://example.com' })(ctx, async () => {});

        expect(response.headers.get('access-control-allow-headers')).toBeUndefined();
      });

      it('lets an explicit list win and refuse everything outside it', async () => {
        const { ctx, response } = preflight('content-type, x-secret');
        await corsMiddleware({
          origin: 'https://example.com',
          allowedHeaders: ['content-type'],
        })(ctx, async () => {});

        expect(response.headers.get('access-control-allow-headers')).toBe('content-type');
      });

      it('keeps an explicit EMPTY list meaning deny-everything', async () => {
        // `undefined` and `[]` are different: omitting the option opts into
        // echoing, while an explicit empty list is a deliberate refusal.
        const { ctx, response } = preflight('content-type');
        await corsMiddleware({ origin: 'https://example.com', allowedHeaders: [] })(
          ctx,
          async () => {},
        );

        expect(response.headers.get('access-control-allow-headers')).toBeUndefined();
      });

      it('echoes nothing for a DENIED origin', async () => {
        const { ctx, response } = createFakeContext({
          request: {
            method: 'OPTIONS',
            headers: {
              Origin: 'https://evil.com',
              'Access-Control-Request-Method': 'POST',
              'Access-Control-Request-Headers': 'content-type',
            },
          },
        });
        await corsMiddleware({ origin: 'https://example.com' })(ctx, async () => {});

        expect(response.headers.get('access-control-allow-headers')).toBeUndefined();
        expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
      });
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

  describe('Vary', () => {
    it('sets Vary: Origin even when the origin is DENIED', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: { method: 'GET', headers: { Origin: 'https://evil.test' } },
      });
      const mw = corsMiddleware({ origin: ['https://good.test'] });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      // The response body is produced without CORS headers, so a shared cache
      // must not reuse it for an allowed origin (or the reverse).
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('access-control-allow-origin')).toBeUndefined();
      expect(response.appendedHeaders.get('vary')).toEqual(['Origin']);
    });

    it('sets Vary: Origin exactly once on an allowed request', async () => {
      const { ctx, response } = createFakeContext({
        request: { method: 'GET', headers: { Origin: 'https://good.test' } },
      });
      const mw = corsMiddleware({ origin: ['https://good.test'] });
      await mw(ctx, async () => {});
      expect(response.appendedHeaders.get('vary')).toEqual(['Origin']);
    });

    it('sets Vary: Origin on a denied preflight', async () => {
      const { ctx, response } = createFakeContext({
        request: {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://evil.test',
            'Access-Control-Request-Method': 'POST',
          },
        },
      });
      const mw = corsMiddleware({ origin: ['https://good.test'] });
      await mw(ctx, async () => {});
      expect(response.statuses).toContain(204);
      expect(response.appendedHeaders.get('vary')).toEqual(['Origin']);
    });
  });
});
