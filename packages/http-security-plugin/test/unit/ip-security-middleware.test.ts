// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ipSecurityMiddleware } from '../../src/middleware/ip-security-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

describe('ipSecurityMiddleware', () => {
  describe('enabled: false', () => {
    it('returns pass-through middleware', async () => {
      const { ctx, nextCalled } = createFakeContext();
      const mw = ipSecurityMiddleware({ enabled: false });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('trustProxy: true', () => {
    it('resolves leftmost IP from X-Forwarded-For', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          headers: { 'X-Forwarded-For': '1.2.3.4, 10.0.0.1' },
        },
      });
      const mw = ipSecurityMiddleware({ trustProxy: true });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(ctx.state.get('clientIp')).toBe('1.2.3.4');
    });

    it('uses custom ipHeader', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          headers: { 'X-Real-IP': '5.6.7.8' },
        },
      });
      const mw = ipSecurityMiddleware({
        trustProxy: true,
        ipHeader: 'X-Real-IP',
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(ctx.state.get('clientIp')).toBe('5.6.7.8');
    });

    it('falls back to request.ip when header absent', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { ip: '192.168.1.1' },
      });
      const mw = ipSecurityMiddleware({ trustProxy: true });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(ctx.state.get('clientIp')).toBe('192.168.1.1');
    });

    it('handles single IP in X-Forwarded-For', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          headers: { 'X-Forwarded-For': '203.0.113.50' },
        },
      });
      const mw = ipSecurityMiddleware({ trustProxy: true });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(ctx.state.get('clientIp')).toBe('203.0.113.50');
    });
  });

  describe('trustProxy: false (default)', () => {
    it('uses request.ip', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { ip: '192.168.1.1' },
      });
      const mw = ipSecurityMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(ctx.state.get('clientIp')).toBe('192.168.1.1');
    });

    it('ignores X-Forwarded-For when trustProxy is false', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          ip: '192.168.1.1',
          headers: { 'X-Forwarded-For': '1.2.3.4' },
        },
      });
      const mw = ipSecurityMiddleware({ trustProxy: false });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(ctx.state.get('clientIp')).toBe('192.168.1.1');
    });

    it('publishes undefined when request.ip is absent', async () => {
      const { ctx, nextCalled } = createFakeContext();
      const mw = ipSecurityMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(ctx.state.has('clientIp')).toBe(true);
      expect(ctx.state.get('clientIp')).toBeUndefined();
    });
  });

  describe('always calls next()', () => {
    it('never short-circuits', async () => {
      const { ctx, nextCalled } = createFakeContext();
      const mw = ipSecurityMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });
});
