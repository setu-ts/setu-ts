// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
/**
 * `trustedProxies` / `proxyHops` — resolving the client from the RIGHT
 * (M90a §3.3).
 *
 * X32-3: `trustProxy: true` took the header's LEFTMOST entry, and the standard
 * nginx idiom `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
 * APPENDS the peer address rather than overwriting the header. So a client
 * sending `X-Forwarded-For: 7.7.7.7` reached the application as
 * `7.7.7.7, 198.51.100.9` and the leftmost entry — the value the caller chose —
 * became `CLIENT_IP_STATE_KEY`, which the default rate-limit key reads.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ipSecurityMiddleware } from '../../src/middleware/ip-security-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';
import { CLIENT_IP_STATE_KEY } from '@setu-ts/common';
import type { IpSecurityOptions } from '../../src/middleware/ip-security-middleware.ts';

/** Resolves the client IP for one header value under one configuration. */
async function resolve(
  headerValue: string | undefined,
  options: IpSecurityOptions,
): Promise<unknown> {
  const { ctx, nextCalled } = createFakeContext({
    request: headerValue === undefined ? {} : { headers: { 'X-Forwarded-For': headerValue } },
  });
  const mw = ipSecurityMiddleware({ trustProxy: true, ...options });
  await mw(ctx, async () => {
    nextCalled.push(true);
  });
  expect(nextCalled).toHaveLength(1);
  return ctx.state.get(CLIENT_IP_STATE_KEY);
}

// The chain an appending proxy produces from a request that arrived carrying a
// forged `X-Forwarded-For: 7.7.7.7`.
const APPENDED = '7.7.7.7, 198.51.100.9';

describe('ipSecurityMiddleware proxy resolution (X32-3)', () => {
  it('with neither option, resolution stays LEFTMOST — unchanged', async () => {
    // Not a bug being preserved: X32-3 is Medium precisely because it needs
    // the operator to have opted into `trustProxy`, so flipping the default
    // would be a larger behaviour change than the finding.
    expect(await resolve(APPENDED, {})).toBe('7.7.7.7');
  });

  describe('trustedProxies', () => {
    it('resolves the rightmost entry that is not a trusted proxy', async () => {
      // `trustedProxies` lists the addresses that appear in the header BECAUSE
      // a proxy further out contributed them. Under one appending nginx the
      // header contains no proxy address at all — nginx appends its PEER, the
      // real client — so nothing in this chain is trusted and the rightmost
      // entry is the answer. `7.7.7.7`, the value the caller forged, is
      // correctly ignored.
      expect(await resolve(APPENDED, { trustedProxies: ['10.0.0.1'] }))
        .toBe('198.51.100.9');
    });

    it('walks PAST several trusted hops', async () => {
      expect(
        await resolve('7.7.7.7, 203.0.113.5, 10.0.0.1, 10.0.0.2', {
          trustedProxies: ['10.0.0.1', '10.0.0.2'],
        }),
      ).toBe('203.0.113.5');
    });

    it('matches an IPv4 CIDR block', async () => {
      expect(
        await resolve('7.7.7.7, 203.0.113.5, 10.0.0.7', { trustedProxies: ['10.0.0.0/8'] }),
      ).toBe('203.0.113.5');
    });

    it('a /32 block matches exactly that address and nothing else', async () => {
      expect(await resolve('203.0.113.5, 10.0.0.1', { trustedProxies: ['10.0.0.1/32'] }))
        .toBe('203.0.113.5');
      expect(await resolve('203.0.113.5, 10.0.0.2', { trustedProxies: ['10.0.0.1/32'] }))
        .toBe('10.0.0.2');
    });

    it('a /0 block trusts every IPv4 address', async () => {
      expect(await resolve('1.2.3.4, 5.6.7.8', { trustedProxies: ['0.0.0.0/0'] }))
        .toBeUndefined();
    });

    it('resolves undefined when EVERY entry is a trusted proxy', async () => {
      // The client address was never recorded, so there is nothing honest to
      // return — reporting a proxy's own address as the client would be worse
      // than reporting nothing.
      expect(await resolve('10.0.0.1, 10.0.0.2', { trustedProxies: ['10.0.0.0/8'] }))
        .toBeUndefined();
    });

    it('a malformed CIDR falls back to a literal string comparison', async () => {
      // A wrong numeric expansion would silently TRUST an untrusted hop, so an
      // unparseable block matches only its own literal text.
      expect(await resolve('1.2.3.4, 10.0.0.1/99', { trustedProxies: ['10.0.0.1/99'] }))
        .toBe('1.2.3.4');
      expect(await resolve('1.2.3.4, 10.0.0.5', { trustedProxies: ['10.0.0.1/99'] }))
        .toBe('10.0.0.5');
    });

    it('an IPv6 proxy is matched case-insensitively as a literal', async () => {
      expect(
        await resolve('1.2.3.4, 2001:DB8::1', { trustedProxies: ['2001:db8::1'] }),
      ).toBe('1.2.3.4');
    });

    it('an octet above 255 is not a valid address and never matches a CIDR', async () => {
      expect(await resolve('1.2.3.4, 10.0.0.300', { trustedProxies: ['10.0.0.0/8'] }))
        .toBe('10.0.0.300');
    });

    it('a padded or short dotted-quad is not treated as IPv4', async () => {
      // `Number(' 1')` is 1 and `Number('')` is 0, so the digits are checked
      // explicitly rather than inferred from the conversion.
      expect(await resolve('1.2.3.4, 10.0.0', { trustedProxies: ['10.0.0.0/8'] }))
        .toBe('10.0.0');
      expect(await resolve('1.2.3.4, 10.0.0.0001', { trustedProxies: ['10.0.0.0/8'] }))
        .toBe('10.0.0.0001');
    });

    it('an empty trustedProxies list trusts nothing, so the rightmost wins', async () => {
      // Distinct from OMITTING the option, which stays leftmost.
      expect(await resolve(APPENDED, { trustedProxies: [] })).toBe('198.51.100.9');
    });
  });

  describe('proxyHops', () => {
    it('resolves the nth entry from the right', async () => {
      expect(await resolve(APPENDED, { proxyHops: 1 })).toBe('7.7.7.7');
      expect(await resolve('a, b, 203.0.113.5, 10.0.0.1, 10.0.0.2', { proxyHops: 2 }))
        .toBe('203.0.113.5');
    });

    it('proxyHops: 0 is the rightmost entry', async () => {
      expect(await resolve(APPENDED, { proxyHops: 0 })).toBe('198.51.100.9');
    });

    it('a header too short for the declared chain resolves undefined', async () => {
      // Guessing the leftmost entry here would reintroduce the spoof this
      // option exists to close: a short header means the request did not
      // traverse the expected chain.
      expect(await resolve('7.7.7.7', { proxyHops: 2 })).toBeUndefined();
    });
  });

  describe('shared parsing', () => {
    it('trims whitespace and skips empty entries', async () => {
      expect(await resolve('  7.7.7.7 , , 198.51.100.9  ', { proxyHops: 0 }))
        .toBe('198.51.100.9');
      expect(await resolve('  7.7.7.7 , , 198.51.100.9  ', {})).toBe('7.7.7.7');
    });

    it('a header of only separators resolves undefined', async () => {
      expect(await resolve(' , , ', { trustedProxies: ['10.0.0.1'] })).toBeUndefined();
      expect(await resolve(' , , ', { proxyHops: 1 })).toBeUndefined();
      expect(await resolve(' , , ', {})).toBeUndefined();
    });

    it('an absent header falls through to request.ip regardless of mode', async () => {
      const { ctx, nextCalled } = createFakeContext({ request: { ip: '192.168.1.1' } });
      const mw = ipSecurityMiddleware({ trustProxy: true, trustedProxies: ['10.0.0.1'] });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('192.168.1.1');
    });

    it('a custom ipHeader is honoured by the new modes', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { headers: { 'X-Real-IP': '7.7.7.7, 198.51.100.9' } },
      });
      const mw = ipSecurityMiddleware({
        trustProxy: true,
        ipHeader: 'X-Real-IP',
        trustedProxies: ['10.0.0.1'],
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBe('198.51.100.9');
    });
  });

  describe('mutual exclusion', () => {
    it('supplying both options throws at middleware CONSTRUCTION', async () => {
      // At construction rather than per request: the two are different answers
      // to one question, so the configuration is wrong before any traffic
      // arrives and an operator should learn that at startup.
      expect(() =>
        ipSecurityMiddleware({
          trustProxy: true,
          trustedProxies: ['10.0.0.1'],
          proxyHops: 1,
        })
      ).toThrow(/mutually/);
    });

    it('the refusal fires even with trustProxy off', async () => {
      // The options are meaningless without `trustProxy`, but a configuration
      // naming both is a mistake whether or not it is currently reachable.
      expect(() => ipSecurityMiddleware({ trustedProxies: ['10.0.0.1'], proxyHops: 1 })).toThrow(
        /mutually/,
      );
    });

    it('a disabled middleware is a pass-through before the refusal', async () => {
      // `enabled: false` returns before any option is read, which is the
      // released ordering; the check must not turn an explicitly disabled
      // middleware into a startup failure.
      const mw = ipSecurityMiddleware({
        enabled: false,
        trustedProxies: ['10.0.0.1'],
        proxyHops: 1,
      });
      const { ctx, nextCalled } = createFakeContext();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });
});
