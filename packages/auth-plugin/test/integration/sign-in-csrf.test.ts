import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getCsrfToken, SessionPlugin } from '@setu-ts/session-plugin';
import { AuthPlugin } from '../../src/index.ts';
import { asPendingPromotion } from '../../src/sign-in/auth-session-service.ts';

describe('sign-in rotates form CSRF', () => {
  it.each([false, true])(
    'rotates on password sign-in and pending MFA promotion (MFA=%s)',
    async (mfa) => {
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          SessionPlugin({ secret: 'sign-in-csrf-session-secret-at-least-32', csrf: {} }),
          AuthPlugin({
            signIn: { providers: [], ...(mfa ? { mfa: { required: () => true } } : {}) },
          }),
        ],
      });
      app.router.get('/token', (ctx) => ctx.response.json({ token: getCsrfToken(ctx) }));
      app.router.post('/sign-in', async (ctx) =>
        ctx.response.json(
          await ctx.services
            .get(CAPABILITIES.AUTH_SESSION)
            .signIn(ctx, { id: 'alice' }, { methods: ['pwd'] }),
        ),
      );
      app.router.post('/promote', (ctx) =>
        ctx.response.json({
          status: asPendingPromotion(ctx.services.get(CAPABILITIES.AUTH_SESSION))!.promotePending(
            ctx,
            'otp',
          ),
        }),
      );
      app.router.post('/write', (ctx) => ctx.response.json({ ok: true }));
      await app.start();
      try {
        let cookie = '';
        let token = '';
        const fresh = async (): Promise<void> => {
          const response = await app.inject({ method: 'GET', url: '/token', headers: { cookie } });
          cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
          token = response.json<{ token: string }>().token;
        };
        await fresh();
        for (const path of mfa ? ['/sign-in', '/promote'] : ['/sign-in']) {
          const old = token;
          const response = await app.inject({
            method: 'POST',
            url: path,
            headers: { cookie, 'x-csrf-token': old },
          });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toMatchObject({
            status: path === '/sign-in' && mfa ? 'second-factor-required' : 'signed-in',
          });
          cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
          expect(
            (
              await app.inject({
                method: 'POST',
                url: '/write',
                headers: { cookie, 'x-csrf-token': old },
              })
            ).statusCode,
          ).toBe(403);
          await fresh();
          expect(token).not.toBe(old);
          expect(
            (
              await app.inject({
                method: 'POST',
                url: '/write',
                headers: { cookie, 'x-csrf-token': token },
              })
            ).statusCode,
          ).toBe(200);
        }
      } finally {
        await app.stop();
      }
    },
  );
});
