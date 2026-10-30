/* eslint-disable require-await -- test fixtures use sync methods matching async interface signatures */
import { describe, expect, it } from 'vitest';

import { ipSecurityMiddleware } from '../../src/middleware/ip-security-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';
import { CLIENT_IP_STATE_KEY } from '@setu-ts/common';

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
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('1.2.3.4');
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
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('5.6.7.8');
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
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('192.168.1.1');
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
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('203.0.113.50');
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
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('192.168.1.1');
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
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('192.168.1.1');
    });

    it('publishes undefined when request.ip is absent', async () => {
      const { ctx, nextCalled } = createFakeContext();
      const mw = ipSecurityMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(ctx.state.has(CLIENT_IP_STATE_KEY)).toBe(true);
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBeUndefined();
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

  describe('one normalized identity (M119d §3.3)', () => {
    it('publishes a mapped forwarded IPv6 client as dotted IPv4', async () => {
      const { ctx } = createFakeContext({
        request: { headers: { Forwarded: 'for="[::ffff:198.51.100.7]"' } },
      });
      await ipSecurityMiddleware({ trustProxy: true, forwardedHeader: 'forwarded' })(ctx, () =>
        Promise.resolve(),
      );
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('198.51.100.7');
    });

    it('normalizes the socket peer when trustProxy is off', async () => {
      const { ctx } = createFakeContext({ request: { ip: '2001:DB8::1' } });
      await ipSecurityMiddleware()(ctx, () => Promise.resolve());
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('2001:db8::1');
    });

    it('matches a trusted literal written differently from the hop', async () => {
      const { ctx } = createFakeContext({
        request: { headers: { 'X-Forwarded-For': '7.7.7.7, 2001:db8::5' } },
      });
      await ipSecurityMiddleware({
        trustProxy: true,
        trustedProxies: ['2001:DB8:0::5'],
      })(ctx, () => Promise.resolve());
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('7.7.7.7');
    });

    it('does not match an untrusted mapped hop against another IPv4 literal', async () => {
      const { ctx } = createFakeContext({
        request: { headers: { 'X-Forwarded-For': '7.7.7.7, ::ffff:10.0.0.9' } },
      });
      await ipSecurityMiddleware({
        trustProxy: true,
        trustedProxies: ['10.0.0.8'],
      })(ctx, () => Promise.resolve());
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('10.0.0.9');
    });
  });
});
