/**
 * `X-Forwarded-Host` is believed only on `trustForwardedHost`, and both
 * `X-Forwarded-*` origin components are read from the RIGHT.
 *
 * A trusted proxy that passes a client's `X-Forwarded-Host` through
 * (Cloudflare Tunnel's cloudflared) let the client choose the host of every
 * absolute URL the application built, because the leftmost entry was believed
 * after any trusted peer.
 */
import { describe, expect, it } from 'vitest';

import { CLIENT_IP_STATE_KEY, requestOriginOf } from '@setu-ts/common';
import { ipSecurityMiddleware } from '../../src/middleware/ip-security-middleware.ts';
import type { IpSecurityOptions } from '../../src/middleware/ip-security-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

const URL_ORIGIN = 'http://app.example';

async function originFor(
  headers: Record<string, string>,
  options: Partial<IpSecurityOptions> = {},
  ip = '127.0.0.1',
): Promise<{ origin: string; ip: unknown }> {
  const { ctx } = createFakeContext({
    request: { url: `${URL_ORIGIN}/signin`, headers, ip },
  });
  await ipSecurityMiddleware({ trustProxy: true, trustedProxies: ['127.0.0.1'], ...options })(
    ctx,
    () => Promise.resolve(),
  );
  return { origin: requestOriginOf(ctx).origin, ip: ctx.state.get(CLIENT_IP_STATE_KEY) };
}

describe('X-Forwarded-Host is opt-in', () => {
  it('keeps the URL host when a trusted proxy passes a client X-Forwarded-Host through', async () => {
    const result = await originFor({
      'X-Forwarded-For': '203.0.113.7',
      'X-Forwarded-Host': 'evil.example',
    });
    expect(result.ip).toBe('203.0.113.7');
    expect(result.origin).toBe(URL_ORIGIN);
  });

  it('reads the rightmost entry, the one the nearest proxy wrote, when opted in', async () => {
    const result = await originFor(
      { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'evil.example, pub.example' },
      { trustForwardedHost: true },
    );
    expect(result.origin).toBe('http://pub.example');
    // An empty rightmost entry is absent: the client's entry to its left is
    // never read in its place (security audit finding 2).
    expect(
      (
        await originFor(
          { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'evil.example, ' },
          { trustForwardedHost: true },
        )
      ).origin,
    ).toBe(URL_ORIGIN);
  });

  // Each rejected rightmost shape keeps the URL host; the entry to its left is
  // never read in its place.
  const REJECTED_RIGHTMOST = [
    'pub.example/x',
    'user@pub.example',
    'pub.example.',
    '"pub.example"',
    'pub.example:99999x',
    '[::1',
    'a'.repeat(260),
  ];
  for (const rightmost of REJECTED_RIGHTMOST) {
    it(`keeps the URL host for a rejected rightmost ${JSON.stringify(rightmost.slice(0, 20))}`, async () => {
      const result = await originFor(
        { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': `good.example, ${rightmost}` },
        { trustForwardedHost: true },
      );
      expect(result.origin).toBe(URL_ORIGIN);
    });
  }

  it('ignores X-Forwarded-Host from an untrusted peer even when opted in', async () => {
    const result = await originFor(
      { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'pub.example' },
      { trustForwardedHost: true },
      '198.51.100.9',
    );
    expect(result.origin).toBe(URL_ORIGIN);
  });

  it('refuses trustForwardedHost where it could never be read', () => {
    expect(() => ipSecurityMiddleware({ trustProxy: true, trustForwardedHost: true })).toThrow(
      /requires trustProxy: true and trustedProxies/,
    );
    expect(() =>
      ipSecurityMiddleware({ trustedProxies: ['127.0.0.1'], trustForwardedHost: true }),
    ).toThrow(/requires trustProxy: true and trustedProxies/);
    expect(() =>
      ipSecurityMiddleware({
        trustProxy: true,
        trustedProxies: ['127.0.0.1'],
        forwardedHeader: 'forwarded',
        trustForwardedHost: true,
      }),
    ).toThrow(/conflicts with forwardedHeader/);
    // A non-boolean is refused rather than read for truthiness: the string
    // 'false' from untyped configuration would otherwise trust the host.
    for (const value of ['false', 'true', 0, 1, null]) {
      expect(
        () =>
          ipSecurityMiddleware({
            trustProxy: true,
            trustedProxies: ['127.0.0.1'],
            trustForwardedHost: value as unknown as boolean,
          }),
        String(value),
      ).toThrow(/trustForwardedHost must be a boolean/);
    }
    // `false` is the default and is accepted in every mode.
    expect(() => ipSecurityMiddleware({ trustForwardedHost: false })).not.toThrow();
  });
});

describe('X-Forwarded-Proto is read from the right', () => {
  it('takes the rightmost protocol, not a client-prepended one', async () => {
    expect(
      (await originFor({ 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'http, https' }))
        .origin,
    ).toBe('https://app.example');
  });

  // Against an https URL, so reading the client's `http` to the left of an
  // empty rightmost entry would show as a downgrade.
  it('never reads a client protocol left of an empty rightmost entry', async () => {
    for (const proto of ['http, ', 'http,', 'http, ,', 'http,\t']) {
      const { ctx } = createFakeContext({
        request: {
          url: 'https://app.example/',
          headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': proto },
          ip: '127.0.0.1',
        },
      });
      await ipSecurityMiddleware({ trustProxy: true, trustedProxies: ['127.0.0.1'] })(ctx, () =>
        Promise.resolve(),
      );
      expect(requestOriginOf(ctx).origin, JSON.stringify(proto)).toBe('https://app.example');
    }
  });

  it('keeps the URL protocol for a rightmost value that is not http or https', async () => {
    expect(
      (await originFor({ 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https, ftp' }))
        .origin,
    ).toBe(URL_ORIGIN);
  });
});
