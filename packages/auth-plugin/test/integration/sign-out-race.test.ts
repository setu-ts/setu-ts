/**
 * `signOut` on the store strategy stays in force when another request on the same cookie was
 * already in flight and writes after it (the immediate-revocation claim of the JSDoc).
 */
import { expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthSessionService } from '@setu-ts/common';
import { getSession } from '@setu-ts/session-plugin';

import { buildSignInApp, CookieJar } from '../fixtures/sign-in-app.ts';

it('a cookie copied before signOut is signed out even when an in-flight request writes after it', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { app } = await buildSignInApp({
    session: { store: 'memory' },
    signIn: { providers: [] },
    plugins: [
      {
        name: 'race-routes',
        version: '1.0.0',
        register(ctx) {
          ctx.router.post('/slow-write', async (c) => {
            entered();
            await gate;
            getSession(c).set('cart', 1);
            return c.response.json({ ok: true });
          });
          ctx.router.post('/logout', (c) => {
            c.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION).signOut(c);
            return c.response.json({ ok: true });
          });
        },
      },
    ],
  });
  const jar = new CookieJar();
  try {
    await jar.fetch(app, '/password-login', { method: 'POST' });
    const copied = jar.cookie!;
    const withCookie = (path: string, method = 'GET'): Request =>
      new Request(`http://localhost${path}`, { method, headers: { cookie: copied } });
    expect((await app.fetch(withCookie('/me'))).status).toBe(200);

    const inflight = app.fetch(withCookie('/slow-write', 'POST'));
    await inside;
    expect((await app.fetch(withCookie('/logout', 'POST'))).status).toBe(200);
    release();
    const raced = await inflight;
    expect(raced.status).toBe(200);
    expect(raced.headers.getSetCookie()).toEqual([]);

    expect((await app.fetch(withCookie('/me'))).status).toBe(401);
  } finally {
    await app.stop();
  }
});
