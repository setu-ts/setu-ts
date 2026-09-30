/**
 * `IAuthSessionService` (plan §3.1): the record write, the session-id rotation,
 * the read-back, and — the part callers get wrong — what `signOut` actually
 * revokes on each session strategy.
 *
 * The first group drives the service through a fake session so its mutations are
 * observable. The revocation contrast drives a REAL `SessionPlugin` over
 * `app.fetch`, because the difference between the two strategies is entirely in
 * what the cookie carries versus what the server keeps, and no fake can show
 * that.
 */

import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { AuthMethod, IPrincipal } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
import {
  AUTH_SESSION_KEY,
  AuthSessionService,
  ID_TOKEN_SESSION_KEY,
  RP_PROVIDER_SESSION_KEY,
} from '../../src/sign-in/auth-session-service.ts';
import { createFakeSession, createFakeSessionService } from '../fixtures/fake-session.ts';

const PRINCIPAL: IPrincipal = { id: 'u1', roles: ['admin'] };
const NOW = 1_700_000_000_000;
/** A request context is only passed through, so a placeholder stands in for it. */
const CTX = {} as never;

describe('AuthSessionService', () => {
  function service(session = createFakeSession()) {
    return {
      session,
      impl: new AuthSessionService({
        sessionService: createFakeSessionService(session),
        now: () => NOW,
      }),
    };
  }

  it('writes the record and rotates the session id', async () => {
    const { impl, session } = service();
    expect(await impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] })).toEqual({
      status: 'signed-in',
    });
    expect(session.get(AUTH_SESSION_KEY)).toEqual({
      principal: PRINCIPAL,
      methods: ['pwd'],
      at: NOW,
    });
    // Session fixation: an id a caller planted before login does not survive it.
    expect(session.id).toBe('session-1-rotated');
    // The prior sign-in's provider-session facts are cleared before rotation.
    expect(session.mutations).toEqual([
      `set:${AUTH_SESSION_KEY}`,
      `delete:${RP_PROVIDER_SESSION_KEY}`,
      `delete:${ID_TOKEN_SESSION_KEY}`,
      'regenerate',
    ]);
  });

  it('reads the principal back without running the strategy chain', () => {
    const { impl, session } = service();
    expect(impl.current(CTX)).toBeNull();
    void impl.signIn(CTX, PRINCIPAL, { methods: ['fed'] });
    expect(impl.current(CTX)).toEqual(PRINCIPAL);
    // A record whose principal carries no string id is not an identity.
    session.set(AUTH_SESSION_KEY, { principal: { id: 7 }, methods: ['pwd'], at: NOW });
    expect(impl.current(CTX)).toBeNull();
  });

  it('destroys the session on sign-out', () => {
    const { impl, session } = service();
    void impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    impl.signOut(CTX);
    expect(session.destroyed).toBe(true);
    expect(session.mutations.at(-1)).toBe('destroy');
  });

  it('drops an authentication method outside the RFC 8176 set', async () => {
    const { impl, session } = service();
    // A bogus `amr` must not reach an authorization decision that checks for,
    // say, 'pwd': only known values are stored.
    await impl.signIn(CTX, PRINCIPAL, {
      methods: ['pwd', 'something-weird'] as unknown as readonly AuthMethod[],
    });
    const stored = session.get<{ methods: readonly string[] }>(AUTH_SESSION_KEY);
    expect(stored?.methods).toEqual(['pwd']);
  });

  it('refuses to read a corrupted record as an identity', () => {
    const { impl, session } = service();
    void impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    for (
      const corrupt of [
        'string',
        7,
        [],
        { principal: {}, methods: ['pwd'], at: NOW },
        { principal: { id: 'u1' }, methods: 'pwd', at: NOW },
        { principal: { id: 'u1' }, methods: ['pwd'], at: 'now' },
      ]
    ) {
      session.set(AUTH_SESSION_KEY, corrupt);
      expect(impl.current(CTX), JSON.stringify(corrupt)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The revocation contrast, against a real SessionPlugin.
// ---------------------------------------------------------------------------

const SECRET = 'auth-session-service-session-secret-at-least-32';
const BASE = 'http://localhost';
const COOKIE_NAME = 'setu_session';

/**
 * A minimal app whose routes write, read, and destroy the auth-session record
 * through the real session middleware.
 *
 * The `signIn` service itself is covered above; these routes exist so the only
 * variable between the two cases is the session STRATEGY, which is what the
 * assertion is about.
 */
function buildApp(store: 'memory' | undefined): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin(store === undefined ? { secret: SECRET } : { secret: SECRET, store }),
    ],
  });

  app.router.post('/login', (ctx) => {
    const session = getSession(ctx);
    session.set(AUTH_SESSION_KEY, { principal: { id: 'alice' }, methods: ['pwd'], at: 1 });
    session.regenerate();
    return ctx.response.json({ id: session.id });
  });

  app.router.post('/logout', (ctx) => {
    getSession(ctx).destroy();
    return ctx.response.json({ ok: true });
  });

  // Reads the identity the way the auth-session strategy will: from the session.
  app.router.get('/who', (ctx) => {
    const record = getSession(ctx).get<{ principal: { id: string } }>(AUTH_SESSION_KEY);
    return record === undefined
      ? ctx.response.status(401).json({ anonymous: true })
      : ctx.response.json({ id: record.principal.id });
  });

  return app;
}

function cookieOf(response: Response): string {
  const cookies = response.headers.getSetCookie();
  expect(cookies.length).toBe(1);
  const cookie = cookies[0].split(';')[0];
  expect(cookie.startsWith(`${COOKIE_NAME}=`)).toBe(true);
  return cookie;
}

async function login(app: IKernelApplication): Promise<string> {
  const response = await app.fetch(new Request(`${BASE}/login`, { method: 'POST' }));
  expect(response.status).toBe(200);
  return cookieOf(response);
}

async function whoAmI(app: IKernelApplication, cookie: string): Promise<number> {
  return (await app.fetch(new Request(`${BASE}/who`, { headers: { cookie } }))).status;
}

async function logout(app: IKernelApplication, cookie: string): Promise<void> {
  const response = await app.fetch(
    new Request(`${BASE}/logout`, { method: 'POST', headers: { cookie } }),
  );
  expect(response.status).toBe(200);
}

describe('signOut revocation depends on the session strategy', () => {
  let storeApp: IKernelApplication;
  let cookieApp: IKernelApplication;

  beforeAll(async () => {
    storeApp = buildApp('memory');
    cookieApp = buildApp(undefined);
    await storeApp.start();
    await cookieApp.start();
  });

  afterAll(async () => {
    await storeApp.stop();
    await cookieApp.stop();
  });

  it('store strategy: a cookie copied before sign-out is anonymous afterwards', async () => {
    const copied = await login(storeApp);
    expect(await whoAmI(storeApp, copied)).toBe(200);
    await logout(storeApp, copied);
    // The id the copied cookie carries no longer resolves to a stored entry.
    expect(await whoAmI(storeApp, copied)).toBe(401);
  });

  it('cookie strategy: a cookie copied before sign-out keeps authenticating', async () => {
    const copied = await login(cookieApp);
    expect(await whoAmI(cookieApp, copied)).toBe(200);
    await logout(cookieApp, copied);
    // The payload the cookie carries IS the session, so there is nothing
    // server-side to delete and the copy still resolves. Pinned deliberately:
    // the contract and the README both tell callers to use the store strategy
    // when sign-out has to mean revocation.
    expect(await whoAmI(cookieApp, copied)).toBe(200);
  });
});
