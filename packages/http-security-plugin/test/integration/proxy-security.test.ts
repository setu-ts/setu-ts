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
            headers: { Origin: 'https://internal', 'X-Forwarded-Proto': 'https' },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.stop();
    }
  });
});
