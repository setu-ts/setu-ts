import { describe, it, expect } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { ISessionService } from '@setu-ts/common';
import { SessionPlugin } from '../../src/index.ts';

describe('session cookie secure auto', () => {
  for (const proxy of [true, false]) {
    for (const protocol of ['http', 'https']) {
      it(`uses ${protocol} with proxy middleware ${proxy}`, async () => {
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            ...(proxy
              ? [
                  HttpSecurityPlugin({
                    ipSecurity: { trustProxy: true, trustedProxies: ['10.0.0.0/8'] },
                  }),
                ]
              : []),
            SessionPlugin({
              secret: 'session-auto-test-secret-at-least-32-chars',
              cookie: { secure: 'auto' },
            }),
          ],
        });
        app.router.get('/set', (ctx) => {
          ctx.services.get<ISessionService>(CAPABILITIES.SESSION).from(ctx).set('test', 'value');
          return ctx.response.text('set');
        });
        app.router.get('/destroy', (ctx) => {
          ctx.services.get<ISessionService>(CAPABILITIES.SESSION).from(ctx).destroy();
          return ctx.response.text('destroyed');
        });
        await app.start();
        try {
          for (const path of ['set', 'destroy']) {
            const response = await app.inject({
              method: 'GET',
              url: `${proxy ? 'http' : protocol}://internal/${path}`,
              ip: '10.1.2.3',
              headers: { 'X-Forwarded-For': '192.0.2.1', 'X-Forwarded-Proto': protocol },
            });
            const cookie = response.headers.get('set-cookie');
            expect(cookie).toBeTruthy();
            expect(cookie!.includes('; Secure')).toBe(protocol === 'https');
            if (path === 'destroy') expect(cookie).toContain('Max-Age=0');
          }
          if (proxy) {
            const response = await app.inject({
              method: 'GET',
              url: 'http://internal/set',
              ip: '198.51.100.9',
              headers: { 'X-Forwarded-For': '192.0.2.1', 'X-Forwarded-Proto': 'https' },
            });
            expect(response.headers.get('set-cookie')).not.toContain('; Secure');
          }
        } finally {
          await app.stop();
        }
      });
    }
  }
  it('refuses auto with SameSite none at construction', () => {
    expect(() => SessionPlugin({ cookie: { secure: 'auto', sameSite: 'none' } })).toThrow(
      /cookie.secure.*cookie.sameSite/,
    );
  });
  it('refuses invalid secure values without echoing caller data', () => {
    expect(() => SessionPlugin({ cookie: { secure: 'private-input' as 'auto' } })).toThrow(
      "'cookie.secure'",
    );
    try {
      SessionPlugin({ cookie: { secure: 'private-input' as 'auto' } });
    } catch (error) {
      expect(String(error)).not.toContain('private-input');
    }
  });
});
