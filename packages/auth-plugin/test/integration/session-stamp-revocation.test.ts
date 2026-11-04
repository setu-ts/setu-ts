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
