/**
 * End to end (M124 §3.5): a password-only application on a real kernel, real
 * `SessionPlugin` and real `AuthPlugin`, with an in-memory user table standing
 * in for the application's database. Every claim is read back through the
 * public surface: a deactivated user is anonymous on the next request, a
 * browser navigation is sent to the sign-in page while an API call gets a 401,
 * and one bump of a user's session version ends every session that user holds.
 *
 * @module
 */
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { AuthMethod, IAuthSessionService, IPrincipal } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';
import type { SessionPluginOptions } from '@setu-ts/session-plugin';

import { AuthPlugin, requireAuth, safeReturnTo } from '../../src/index.ts';
import { CookieJar, SESSION_SECRET } from '../fixtures/sign-in-app.ts';

/** The application's user record: the stamp lives here, not in the framework. */
interface User {
  active: boolean;
  /** Bumped to sign the user out everywhere. */
  sessionVersion: number;
  /** A password-hash prefix, used as the stamp in the cookie-strategy case. */
  passwordHash: string;
}

const NAVIGATE = { 'sec-fetch-mode': 'navigate' } as const;

describe('session and account lifecycle (M124)', () => {
  let app: IKernelApplication;

  afterEach(async () => {
    await app.stop();
  });

  async function boot(
    users: Map<string, User>,
    session: Partial<SessionPluginOptions>,
    stampOf: (user: User) => string,
  ): Promise<void> {
    app = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({ secret: SESSION_SECRET, ...session }),
        AuthPlugin({
          signIn: {
            providers: [],
            refreshPrincipal: (stored) =>
              users.get(stored.id)?.active === true ? { id: stored.id } : null,
            // Read from the user record, never from a claim: the principal is
            // stored in the session, which the client can read under 'sign'.
            sessionStamp: (principal) => {
              const user = users.get(principal.id);
              return user === undefined ? null : stampOf(user);
            },
          },
        }),
      ],
    });
    // The application's password login: it checks the password itself and
    // hands the principal — carrying the same claim — to the framework.
    app.router.post('/login', async (ctx) => {
      const id = ctx.query.user ?? '';
      const user = users.get(id);
      if (user === undefined) {
        return ctx.response.status(401).json({ error: 'bad credentials' });
      }
      const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
      await auth.signIn(ctx, { id }, { methods: ['pwd'] });
      return ctx.response.redirect(safeReturnTo(ctx.query.returnTo), 303);
    });
    // The application's password change: bump the stamp, then sign THIS
    // session in again with the methods it already recorded.
    app.router.post('/password', {
      middleware: [requireAuth()],
      handler: async (ctx) => {
        const principal = ctx.request.user as IPrincipal;
        const user = users.get(principal.id) as User;
        user.sessionVersion += 1;
        // Stands in for re-hashing the new password.
        user.passwordHash = `${user.passwordHash}-rotated`;
        const methods = (principal.claims?.amr ?? []) as AuthMethod[];
        const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
        await auth.signIn(ctx, { id: principal.id }, { methods });
        return ctx.response.json({ ok: true });
      },
    });
    app.router.get('/account', {
      middleware: [requireAuth({ signInPage: '/login' })],
      handler: (ctx) => ctx.response.json({ id: ctx.request.user?.id }),
    });
    app.router.get('/api/me', {
      middleware: [requireAuth({ signInPage: '/login' })],
      handler: (ctx) => ctx.response.json({ id: ctx.request.user?.id }),
    });
    await app.start();
  }

  async function signIn(user: string): Promise<CookieJar> {
    const jar = new CookieJar();
    const response = await jar.fetch(app, `/login?user=${user}`, { method: 'POST' });
    expect(response.status).toBe(303);
    await response.body?.cancel();
    return jar;
  }

  async function status(jar: CookieJar, path = '/api/me'): Promise<number> {
    const response = await jar.fetch(app, path, { headers: { accept: 'application/json' } });
    await response.body?.cancel();
    return response.status;
  }

  function memoryUsers(): Map<string, User> {
    return new Map([
      ['alice', { active: true, sessionVersion: 1, passwordHash: '$2b$12$alicesaltalicesalt' }],
      ['bob', { active: true, sessionVersion: 1, passwordHash: '$2b$12$bobsaltbobsaltbobs' }],
    ]);
  }

  it('(a) makes the next request anonymous once the user is deactivated', async () => {
    const users = memoryUsers();
    await boot(users, { store: 'memory' }, (user) => String(user.sessionVersion));
    const jar = await signIn('alice');
    expect(await status(jar)).toBe(200);
    (users.get('alice') as User).active = false;
    expect(await status(jar)).toBe(401);
  });

  it('(b) sends a navigation to the sign-in page and answers an API call with 401', async () => {
    await boot(memoryUsers(), { store: 'memory' }, (user) => String(user.sessionVersion));
    const anonymous = new CookieJar();
    const page = await anonymous.fetch(app, '/account?tab=orders', { headers: NAVIGATE });
    expect(page.status).toBe(302);
    const location = page.headers.get('location') ?? '';
    expect(location).toBe('/login?returnTo=%2Faccount%3Ftab%3Dorders');
    await page.body?.cancel();
    const api = await anonymous.fetch(app, '/api/me', { headers: { accept: 'application/json' } });
    expect(api.status).toBe(401);
    expect(api.headers.get('location')).toBeNull();
    await api.body?.cancel();
    // The application's login handler honours the returnTo the guard sent.
    const returnTo = new URL(location, 'http://localhost').searchParams.get('returnTo') ?? '';
    const login = await anonymous.fetch(
      app,
      `/login?user=alice&returnTo=${encodeURIComponent(returnTo)}`,
      { method: 'POST' },
    );
    expect(login.headers.get('location')).toBe('/account?tab=orders');
    await login.body?.cancel();
    const back = await anonymous.fetch(app, '/account?tab=orders', { headers: NAVIGATE });
    expect(await back.json()).toEqual({ id: 'alice' });
  });

  it('(c) ends every session of one user with one bump, and keeps the session that re-signs in', async () => {
    const users = memoryUsers();
    await boot(users, { store: 'memory' }, (user) => String(user.sessionVersion));
    const laptop = await signIn('alice');
    const phone = await signIn('alice');
    const other = await signIn('bob');
    expect([await status(laptop), await status(phone), await status(other)]).toEqual([
      200, 200, 200,
    ]);
    // A password change on the laptop: every other session of alice ends.
    const change = await laptop.fetch(app, '/password', { method: 'POST' });
    expect(change.status).toBe(200);
    await change.body?.cancel();
    expect(await status(laptop)).toBe(200);
    expect(await status(phone)).toBe(401);
    expect(await status(other)).toBe(200);
    // An administrator's "sign out everywhere" is the same one-line bump.
    (users.get('alice') as User).sessionVersion += 1;
    expect(await status(laptop)).toBe(401);
    expect(await status(other)).toBe(200);
  });

  it('(d) records only a digest on the readable signed cookie, and the bump still ends it', async () => {
    const users = memoryUsers();
    // A password-hash prefix as the stamp, as Devise does, on the cookie
    // strategy with a payload the client can read.
    await boot(users, { mode: 'sign' }, (user) => user.passwordHash.slice(0, 29));
    const jar = await signIn('alice');
    expect(await status(jar)).toBe(200);
    const payload = readablePayload(jar.cookie ?? '');
    // The cookie is readable, and the stamp is in it only as a digest.
    expect(payload).toContain('__setu_auth_principal');
    expect(payload).not.toContain('$2b$12$');
    expect(payload).not.toContain('alicesalt');
    const envelope = JSON.parse(payload) as {
      data: Record<string, { stamp?: unknown }>;
    };
    expect(envelope.data.__setu_auth_principal?.stamp).toMatch(/^[A-Za-z0-9_-]{43}$/);
    (users.get('alice') as User).passwordHash = '$2b$12$newsaltnewsaltnewsalt';
    expect(await status(jar)).toBe(401);
  });
});

/** Decodes every base64url part of a signed cookie value and returns the JSON one. */
function readablePayload(cookie: string): string {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  for (const part of value.split('.')) {
    const text = Buffer.from(part, 'base64url').toString('utf8');
    if (text.startsWith('{')) {
      return text;
    }
  }
  throw new Error(`no readable payload in ${value}`);
}
