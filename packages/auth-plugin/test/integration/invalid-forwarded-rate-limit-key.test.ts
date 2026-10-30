import { describe, expect, it } from 'vitest';
import { CLIENT_IP_STATE_KEY } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ipSecurityMiddleware } from '@setu-ts/http-security-plugin';
import { defaultRateLimitKey } from '../../src/index.ts';

describe('rate-limit key after an invalid forwarded address', () => {
  for (const [peer, expected] of [
    [undefined, 'anonymous'],
    ['10.0.0.3', 'ip:10.0.0.3'],
  ] as const) {
    it(`falls back to ${expected}`, async () => {
      const app = createApplication({ plugins: [RuntimePlugin()] });
      app.middleware.add(ipSecurityMiddleware({ trustProxy: true }));
      app.router.get('/', (ctx) => {
        expect(ctx.state.has(CLIENT_IP_STATE_KEY)).toBe(true);
        expect(ctx.state.get(CLIENT_IP_STATE_KEY)).toBeUndefined();
        return ctx.response.text(defaultRateLimitKey(ctx));
      });
      await app.start();
      try {
        const response = await app.inject({
          method: 'GET',
          url: 'http://internal/',
          headers: { 'x-forwarded-for': '<script>' },
          ...(peer === undefined ? {} : { ip: peer }),
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe(expected);
        expect(response.body).not.toBe('ip:<script>');
      } finally {
        await app.stop();
      }
    });
  }
});
