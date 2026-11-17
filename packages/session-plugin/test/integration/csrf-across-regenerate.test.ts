import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getCsrfToken, getSession, SessionPlugin } from '../../src/index.ts';

describe('form CSRF across regeneration', () => {
  it('refuses the pre-login token and accepts a newly fetched token', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({ secret: 'session-regeneration-secret-32-characters', csrf: {} }),
      ],
    });
    app.router.get('/token', (ctx) => ctx.response.json({ token: getCsrfToken(ctx) }));
    app.router.post('/login', (ctx) => {
      getSession(ctx).set('user', 'alice');
      getSession(ctx).regenerate();
      return ctx.response.json({ ok: true });
    });
    app.router.post('/write', (ctx) => ctx.response.json({ user: getSession(ctx).get('user') }));
    await app.start();
    try {
      const initial = await app.inject({ method: 'GET', url: '/token' });
      const old = initial.json<{ token: string }>().token;
      const cookie = (headers: Headers): string => headers.getSetCookie()[0]!.split(';')[0]!;
      const login = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { cookie: cookie(initial.headers), 'x-csrf-token': old },
      });
      expect(login.statusCode).toBe(200);
      const signedIn = cookie(login.headers);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/write',
            headers: { cookie: signedIn, 'x-csrf-token': old },
          })
        ).statusCode,
      ).toBe(403);
      const fresh = await app.inject({
        method: 'GET',
        url: '/token',
        headers: { cookie: signedIn },
      });
      const token = fresh.json<{ token: string }>().token;
      expect(token).not.toBe(old);
      const write = await app.inject({
        method: 'POST',
        url: '/write',
        headers: { cookie: cookie(fresh.headers), 'x-csrf-token': token },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json()).toEqual({ user: 'alice' });
    } finally {
      await app.stop();
    }
  });
});
