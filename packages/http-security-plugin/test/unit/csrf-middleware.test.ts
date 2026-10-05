// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { csrfMiddleware } from '../../src/middleware/csrf-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

describe('csrfMiddleware', () => {
  describe('enabled: false', () => {
    it('returns pass-through middleware', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { method: 'POST' },
      });
      const mw = csrfMiddleware({ enabled: false });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('safe methods', () => {
    it('GET passes through', async () => {
      const { ctx, nextCalled } = createFakeContext({ request: { method: 'GET' } });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('HEAD passes through', async () => {
      const { ctx, nextCalled } = createFakeContext({ request: { method: 'HEAD' } });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('OPTIONS passes through', async () => {
      const { ctx, nextCalled } = createFakeContext({ request: { method: 'OPTIONS' } });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('unsafe methods with same-origin', () => {
    it('same-origin Origin passes (implicit self-trust)', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://app.example.com/api/data',
          headers: { Origin: 'https://app.example.com' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('origin in trustedOrigins passes', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: { Origin: 'https://app.example.com' },
        },
      });
      const mw = csrfMiddleware({
        trustedOrigins: ['https://app.example.com'],
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('cross-origin rejection', () => {
    it('cross-origin not in trusted set returns 403', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware({
        trustedOrigins: ['https://app.example.com'],
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
      // M70f (X4-8): the rejection converges on the responder's `detail` key.
      const body = response.body as { error: string; detail: string };
      expect(body.error).toBe('Forbidden');
      expect(body.detail).toBe('Cross-origin request not allowed');
    });

    it('handler not run on 403 short-circuit', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'PUT',
          url: 'https://api.example.com/resource/1',
          headers: { Origin: 'https://evil.com' },
        },
      });
      let handlerRan = false;
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        handlerRan = true;
        nextCalled.push(true);
      });
      expect(handlerRan).toBe(false);
      expect(response.statuses).toContain(403);
    });
  });

  describe('Referer fallback', () => {
    it('uses Referer origin when Origin absent', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://app.example.com/api/data',
          headers: { Referer: 'https://app.example.com/page' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('Referer from untrusted origin rejected', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: { Referer: 'https://evil.com/attack' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });
  });

  describe('both headers absent', () => {
    it('passes through when both headers absent (empty allowlist)', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: {},
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('passes through when both headers absent (non-empty allowlist)', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: {},
        },
      });
      const mw = csrfMiddleware({
        trustedOrigins: ['https://app.example.com'],
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('customHeader', () => {
    it('rejects when custom header absent', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://app.example.com/api/data',
          headers: {
            Origin: 'https://app.example.com',
          },
        },
      });
      const mw = csrfMiddleware({ customHeader: 'X-CSRF-Token' });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
      // M70f (X4-8): the rejection converges on the responder's `detail` key.
      const body = response.body as { error: string; detail: string };
      expect(body.error).toBe('Forbidden');
      expect(body.detail).toContain('X-CSRF-Token');
    });

    it('passes when custom header present', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://app.example.com/api/data',
          headers: {
            Origin: 'https://app.example.com',
            'X-CSRF-Token': 'abc123',
          },
        },
      });
      const mw = csrfMiddleware({ customHeader: 'X-CSRF-Token' });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('PUT/PATCH/DELETE', () => {
    it('PUT is treated as unsafe', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'PUT',
          url: 'https://api.example.com/resource/1',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });

    it('PATCH is treated as unsafe', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'PATCH',
          url: 'https://api.example.com/resource/1',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });

    it('DELETE is treated as unsafe', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'DELETE',
          url: 'https://api.example.com/resource/1',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });
  });

  describe('exclude (M101c, V8-9)', () => {
    it('an excluded path is checked before the method test and never inspected', async () => {
      // A SAFE method on an excluded path still passes, and the exclusion is
      // what lets an UNSAFE method with an untrusted Origin pass: the path is
      // exempt before the origin is read.
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          path: '/auth/corp/acs',
          url: 'https://api.example.com/auth/corp/acs',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware({ exclude: ['/auth/corp/acs'] });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('a literal-excluded path with Origin: null passes while a non-excluded path is 403', async () => {
      // The Keycloak reproduction: the IdP serves `Referrer-Policy: no-referrer`,
      // so the browser posts the ACS with `Origin: null`. The exemption admits
      // it; the same header on a non-excluded route is refused.
      const excluded = createFakeContext({
        request: {
          method: 'POST',
          path: '/auth/corp/acs',
          url: 'https://api.example.com/auth/corp/acs',
          headers: { Origin: 'null' },
        },
      });
      const mw = csrfMiddleware({ exclude: ['/auth/corp/acs'] });
      await mw(excluded.ctx, async () => {
        excluded.nextCalled.push(true);
      });
      expect(excluded.nextCalled).toHaveLength(1);

      const notExcluded = createFakeContext({
        request: {
          method: 'POST',
          path: '/login',
          url: 'https://api.example.com/login',
          headers: { Origin: 'null' },
        },
      });
      await mw(notExcluded.ctx, async () => {
        notExcluded.nextCalled.push(true);
      });
      expect(notExcluded.nextCalled).toHaveLength(0);
      expect(notExcluded.response.statuses).toContain(403);
    });

    it('a RegExp-excluded path matches by test, including a `g`-flagged pattern twice in a row', async () => {
      // `createPathMatcher` owns the `lastIndex` reset a `g`/`y`-flagged
      // pattern needs; the second request must match identically.
      const mw = csrfMiddleware({ exclude: [/^\/auth\/[a-z]+\/acs$/] });
      for (let i = 0; i < 2; i++) {
        const { ctx, nextCalled } = createFakeContext({
          request: {
            method: 'POST',
            path: '/auth/corp/acs',
            url: 'https://api.example.com/auth/corp/acs',
            headers: { Origin: 'https://evil.com' },
          },
        });
        await mw(ctx, async () => {
          nextCalled.push(true);
        });
        expect(nextCalled).toHaveLength(1);
      }
    });

    it('exclude: [] is byte-identical to today — nothing is exempt', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'POST',
          path: '/auth/corp/acs',
          url: 'https://api.example.com/auth/corp/acs',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware({ exclude: [] });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });
  });
});
