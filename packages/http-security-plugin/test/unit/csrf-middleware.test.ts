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
      const body = response.body as { error: string; message: string };
      expect(body.error).toBe('Forbidden');
      expect(body.message).toBe('Cross-origin request not allowed');
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
      const body = response.body as { error: string; message: string };
      expect(body.error).toBe('Forbidden');
      expect(body.message).toContain('X-CSRF-Token');
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
});
