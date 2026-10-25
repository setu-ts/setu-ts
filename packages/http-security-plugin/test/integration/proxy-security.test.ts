import { describe, it, expect } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { NodeHttpAdapter, RuntimePlugin } from '@setu-ts/runtime';
import type { NodeServeHost } from '@setu-ts/runtime';
import { CLIENT_IP_STATE_KEY, requestOriginOf } from '@setu-ts/common';
import { HttpSecurityPlugin } from '../../src/index.ts';

describe('proxy security through a kernel application', () => {
  it('checks normalized mapped and unmapped peers against the same IPv4 CIDR', async () => {
    let served: Parameters<NodeServeHost['serve']>[0]['fetch'] | undefined;
    const adapter = new NodeHttpAdapter({
      serve(options) {
        served = options.fetch;
        return Promise.resolve({ close() {} });
      },
    });
    const app = createApplication({
      plugins: [
        RuntimePlugin({ platform: 'node', httpAdapters: { node: () => adapter } }),
        HttpSecurityPlugin({ ipSecurity: { trustProxy: true, trustedProxies: ['10.0.0.0/8'] } }),
      ],
    });
    app.router.get('/', (ctx) =>
      ctx.response.json({ peer: ctx.request.ip, client: ctx.state.get(CLIENT_IP_STATE_KEY) }),
    );
    await app.start();
    const handle = await adapter.listen(0);
    try {
      for (const peer of ['10.1.2.3', '::ffff:10.1.2.3', '::FFFF:10.1.2.3']) {
        const response = await served!(
          new Request('http://internal/', { headers: { 'X-Forwarded-For': '192.0.2.1' } }),
          { incoming: { socket: { remoteAddress: peer } } },
        );
        expect(await response.json()).toEqual({ peer: '10.1.2.3', client: '192.0.2.1' });
      }
    } finally {
      await adapter.close(handle);
      await app.stop();
    }
  });
  for (const family of ['x-forwarded', 'forwarded'] as const) {
    it(`checks peers and shares the ${family} public origin`, async () => {
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          HttpSecurityPlugin({
            ipSecurity: {
              trustProxy: true,
              trustedProxies: ['10.0.0.0/8'],
              forwardedHeader: family,
            },
            csrf: {},
          }),
        ],
      });
      app.router.get('/', (ctx) =>
        ctx.response.json({
          ip: ctx.state.get(CLIENT_IP_STATE_KEY),
          origin: requestOriginOf(ctx).origin,
        }),
      );
      app.router.post('/', (ctx) => ctx.response.text('accepted'));
      await app.start();
      const headers =
        family === 'forwarded'
          ? { Forwarded: 'for=192.0.2.1;proto=https;host=public.example' }
          : {
              'X-Forwarded-For': '192.0.2.1',
              'X-Forwarded-Proto': 'https',
              'X-Forwarded-Host': 'public.example',
            };
      try {
        const direct = await app.inject({
          method: 'GET',
          url: 'http://internal/',
          ip: '198.51.100.9',
          headers,
        });
        expect(direct.json()).toEqual({ ip: '198.51.100.9', origin: 'http://internal' });
        const proxied = await app.inject({
          method: 'GET',
          url: 'http://internal/',
          ip: '10.1.2.3',
          headers,
        });
        expect(proxied.json()).toEqual({ ip: '192.0.2.1', origin: 'https://public.example' });
        expect(
          (
            await app.inject({
              method: 'POST',
              url: 'http://internal/',
              ip: '10.1.2.3',
              headers: { ...headers, Origin: 'https://public.example' },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: 'http://internal/',
              ip: '10.1.2.3',
              headers: { ...headers, Origin: 'https://evil.example' },
            })
          ).statusCode,
        ).toBe(403);
      } finally {
        await app.stop();
      }
    });
  }
  it('accepts an https form POST with csrf alone', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), HttpSecurityPlugin({ csrf: {} })] });
    app.router.post('/', (ctx) => ctx.response.text('accepted'));
    await app.start();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: 'http://internal/',
            headers: {
              Origin: 'https://internal',
              'X-Forwarded-Proto': 'https',
              'Sec-Fetch-Site': 'same-origin',
            },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.stop();
    }
  });
  // M113n audit N1: a trusted proxy that passes a client's X-Forwarded-Host
  // through publishes that host; a cross-site browser request must not match it.
  it('refuses a published origin a cross-site request chose through a pass-through proxy', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HttpSecurityPlugin({
          cors: { origin: ['https://evil.example'], credentials: true },
          ipSecurity: { trustProxy: true, trustedProxies: ['10.0.0.0/8'] },
          csrf: {},
        }),
      ],
    });
    app.router.post('/', (ctx) => ctx.response.text('accepted'));
    await app.start();
    const post = (origin: string, site: string | undefined, host: string | undefined) =>
      app.inject({
        method: 'POST',
        url: 'http://internal/',
        ip: '10.0.0.5',
        headers: {
          Origin: origin,
          'X-Forwarded-For': '192.0.2.1',
          'X-Forwarded-Proto': 'https',
          ...(host === undefined ? {} : { 'X-Forwarded-Host': host }),
          ...(site === undefined ? {} : { 'Sec-Fetch-Site': site }),
        },
      });
    try {
      for (const site of ['cross-site', 'same-site', 'none']) {
        expect((await post('https://evil.example', site, 'evil.example')).statusCode, site).toBe(
          403,
        );
      }
      // Legitimate traffic through the same proxy is unaffected.
      expect((await post('https://app.example', 'same-origin', 'app.example')).statusCode).toBe(
        200,
      );
      expect((await post('https://app.example', undefined, 'app.example')).statusCode).toBe(200);
    } finally {
      await app.stop();
    }
  });
  // M113n audit F1: `X-Forwarded-*` are not forbidden request headers, and the
  // CORS middleware echoes requested headers by default, so a script on a
  // credentialed CORS origin could name its own host and match its own Origin.
  it('refuses a credentialed CORS origin naming itself in X-Forwarded-Host', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HttpSecurityPlugin({
          cors: { origin: ['https://partner.example'], credentials: true },
          csrf: {},
        }),
      ],
    });
    app.router.post('/', (ctx) => ctx.response.text('accepted'));
    await app.start();
    try {
      const preflight = await app.fetch(
        new Request('http://internal/', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://partner.example',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'x-forwarded-host,x-forwarded-proto',
          },
        }),
      );
      // The preflight admits the headers, which is what makes the attack reachable.
      expect(preflight.headers.get('access-control-allow-headers')).toBe(
        'x-forwarded-host,x-forwarded-proto',
      );
      for (const site of [undefined, 'cross-site', 'same-site']) {
        const response = await app.inject({
          method: 'POST',
          url: 'http://internal/',
          headers: {
            Origin: 'https://partner.example',
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'partner.example',
            ...(site === undefined ? {} : { 'Sec-Fetch-Site': site }),
          },
        });
        expect(response.statusCode, String(site)).toBe(403);
      }
    } finally {
      await app.stop();
    }
  });

  it('V10-19: two clients behind one appending proxy keep distinct identities', async () => {
    // A trusted proxy APPENDS its element, so a client's malformed prefix must
    // be a boundary rather than erasing the appended client (the 0.10.0
    // defect: both callers fell into one shared fallback bucket).
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HttpSecurityPlugin({
          ipSecurity: {
            trustProxy: true,
            trustedProxies: ['10.0.0.0/8'],
            forwardedHeader: 'forwarded',
          },
        }),
      ],
    });
    app.router.get('/', (ctx) => ctx.response.json({ client: ctx.state.get(CLIENT_IP_STATE_KEY) }));
    await app.start();
    const clientFor = (forwarded: string) =>
      app.inject({
        method: 'GET',
        url: 'http://internal/',
        ip: '10.1.2.3',
        headers: { Forwarded: forwarded },
      });
    try {
      const first = await clientFor('garbage, for=198.51.100.7');
      const second = await clientFor('for="unterminated, for=198.51.100.8');
      expect(first.json()).toEqual({ client: '198.51.100.7' });
      expect(second.json()).toEqual({ client: '198.51.100.8' });
    } finally {
      await app.stop();
    }
  });
  it('V10-28: mapped and unmapped forwarded forms of one client publish one value', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HttpSecurityPlugin({
          ipSecurity: {
            trustProxy: true,
            trustedProxies: ['10.0.0.0/8'],
            forwardedHeader: 'forwarded',
          },
        }),
      ],
    });
    app.router.get('/', (ctx) => ctx.response.json({ client: ctx.state.get(CLIENT_IP_STATE_KEY) }));
    await app.start();
    try {
      const mapped = await app.inject({
        method: 'GET',
        url: 'http://internal/',
        ip: '10.1.2.3',
        headers: { Forwarded: 'for="[::ffff:198.51.100.7]"' },
      });
      const plain = await app.inject({
        method: 'GET',
        url: 'http://internal/',
        ip: '10.1.2.3',
        headers: { Forwarded: 'for=198.51.100.7' },
      });
      const hexTail = await app.inject({
        method: 'GET',
        url: 'http://internal/',
        ip: '10.1.2.3',
        headers: { Forwarded: 'for="[::ffff:c633:6407]"' },
      });
      expect(mapped.json()).toEqual({ client: '198.51.100.7' });
      expect(plain.json()).toEqual({ client: '198.51.100.7' });
      expect(hexTail.json()).toEqual({ client: '198.51.100.7' });
    } finally {
      await app.stop();
    }
  });
});
