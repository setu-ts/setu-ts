import { expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { ISessionService } from '@setu-ts/common';
import { AUTH_SESSION_KEY } from '../../src/sign-in/auth-session-service.ts';
import { buildSignInApp, CookieJar } from '../fixtures/sign-in-app.ts';

it('M131b 3.13 revokes a stored session permanently after a definite mismatch', async () => {
  let stamp = 'v1';
  const { app } = await buildSignInApp({
    session: { store: 'memory' },
    signIn: { providers: [], sessionStamp: () => stamp },
  });
  const jar = new CookieJar();
  try {
    await jar.fetch(app, '/password-login', { method: 'POST' });
    const oldCookie = jar.cookie!;
    const before = (await (await jar.fetch(app, '/_session')).json()) as { id: string };
    stamp = 'v2';
    expect((await jar.fetch(app, '/me')).status).toBe(401);
    const after = (await (await jar.fetch(app, '/_session')).json()) as { id: string };
    expect(after.id).not.toBe(before.id);
    expect(jar.cookie).not.toBe(oldCookie);
    stamp = 'v1';
    expect((await jar.fetch(app, '/me')).status).toBe(401);
    expect(
      (await app.fetch(new Request('http://localhost/me', { headers: { cookie: oldCookie } })))
        .status,
    ).toBe(401);
  } finally {
    await app.stop();
  }
});

it('M131b audit F1: a mismatch seen by a throwing request still revokes the stored session', async () => {
  let stamp = 'v1';
  const { app } = await buildSignInApp({
    session: { store: 'memory' },
    signIn: { providers: [], sessionStamp: () => stamp },
    plugins: [
      {
        name: 'throwing-route',
        version: '1.0.0',
        register(ctx) {
          ctx.router.get('/boom', () => {
            throw new Error('handler failed');
          });
        },
      },
    ],
  });
  const jar = new CookieJar();
  try {
    await jar.fetch(app, '/password-login', { method: 'POST' });
    const oldCookie = jar.cookie!;
    const withCookie = (path: string): Request =>
      new Request(`http://localhost${path}`, { headers: { cookie: oldCookie } });
    stamp = 'v2';
    // The mismatch is detected on a request whose handler throws: no commit runs.
    expect((await app.fetch(withCookie('/boom'))).status).toBe(500);
    stamp = 'v1';
    expect((await app.fetch(withCookie('/me'))).status).toBe(401);
  } finally {
    await app.stop();
  }
});

it('M131b review: an auth middleware that runs before the session middleware suspends, not 500s', async () => {
  let stamp = 'v1';
  const { app } = await buildSignInApp({
    session: { store: 'memory' },
    signIn: { providers: [], sessionStamp: () => stamp },
    authPriority: 200,
  });
  const jar = new CookieJar();
  try {
    await jar.fetch(app, '/password-login', { method: 'POST' });
    const before = (await (await jar.fetch(app, '/_session')).json()) as { id: string };
    stamp = 'v2';
    expect((await jar.fetch(app, '/me')).status).toBe(401);
    // Suspension-only: the session the mismatch was seen on is not rotated.
    const after = (await (await jar.fetch(app, '/_session')).json()) as { id: string };
    expect(after.id).toBe(before.id);
  } finally {
    await app.stop();
  }
});

it('M131b 3.13 reader faults suspend one request without deleting or rotating its session', async () => {
  let unavailable = false;
  const { app } = await buildSignInApp({
    session: { store: 'memory' },
    signIn: {
      providers: [],
      sessionStamp: () => {
        if (unavailable) throw new Error('identity store unavailable');
        return 'v1';
      },
    },
  });
  const jar = new CookieJar();
  try {
    await jar.fetch(app, '/password-login', { method: 'POST' });
    const cookie = jar.cookie!;
    const service = app.services.get<ISessionService>(CAPABILITIES.SESSION);
    const before = await service.fromHeaders(new Headers({ cookie }));
    unavailable = true;
    expect((await jar.fetch(app, '/me')).status).toBe(401);
    const after = await service.fromHeaders(new Headers({ cookie }));
    expect(after).toEqual(before);
    expect(after?.data[AUTH_SESSION_KEY]).toBeDefined();
    unavailable = false;
    expect((await jar.fetch(app, '/me')).status).toBe(200);
    expect(jar.cookie).toBe(cookie);
  } finally {
    await app.stop();
  }
});
