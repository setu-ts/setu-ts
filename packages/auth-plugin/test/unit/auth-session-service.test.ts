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
import type { AuthMethod, IAuthSessionService, IPrincipal } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
import {
  asPendingPromotion,
  AUTH_SESSION_KEY,
  AuthSessionService,
  DEFAULT_PENDING_TTL_MS,
  ID_TOKEN_SESSION_KEY,
  PENDING_MFA_SESSION_KEY,
  RP_PROVIDER_SESSION_KEY,
  SCOPED_GRANTS_SESSION_KEY,
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
      `delete:${PENDING_MFA_SESSION_KEY}`,
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

  it('MFA required: stores pending record and returns second-factor-required', async () => {
    const session = createFakeSession();
    const impl = new AuthSessionService({
      sessionService: createFakeSessionService(session),
      now: () => NOW,
      mfa: {
        required: () => true,
        pendingTtlMs: 300_000,
      },
    });
    const outcome = await impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    expect(outcome).toEqual({ status: 'second-factor-required' });
    // The pending record is written, not the signed-in record.
    expect(session.get(AUTH_SESSION_KEY)).toBeUndefined();
    expect(session.get(PENDING_MFA_SESSION_KEY)).toEqual({
      principal: PRINCIPAL,
      methods: ['pwd'],
      at: NOW,
    });
    // Session is rotated.
    expect(session.id).toBe('session-1-rotated');
  });

  it('MFA required: pending() reads the pending record back', async () => {
    const session = createFakeSession();
    const impl = new AuthSessionService({
      sessionService: createFakeSessionService(session),
      now: () => NOW,
      mfa: {
        required: () => true,
        pendingTtlMs: 300_000,
      },
    });
    await impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    const pending = impl.pending(CTX);
    expect(pending).not.toBeNull();
    expect(pending?.principal).toEqual(PRINCIPAL);
    expect(pending?.methods).toEqual(['pwd']);
  });

  it('MFA not required: signs in normally', async () => {
    const session = createFakeSession();
    const impl = new AuthSessionService({
      sessionService: createFakeSessionService(session),
      now: () => NOW,
      mfa: {
        required: () => false,
        pendingTtlMs: 300_000,
      },
    });
    const outcome = await impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    expect(outcome).toEqual({ status: 'signed-in' });
    expect(session.get(AUTH_SESSION_KEY)).toBeDefined();
    expect(session.get(PENDING_MFA_SESSION_KEY)).toBeUndefined();
  });

  it('MFA with otp in methods: skips the MFA check entirely', async () => {
    const session = createFakeSession();
    let called = false;
    const impl = new AuthSessionService({
      sessionService: createFakeSessionService(session),
      now: () => NOW,
      mfa: {
        required: () => {
          called = true;
          return true;
        },
        pendingTtlMs: 300_000,
      },
    });
    const outcome = await impl.signIn(CTX, PRINCIPAL, { methods: ['pwd', 'otp'] });
    expect(outcome).toEqual({ status: 'signed-in' });
    expect(called).toBe(false);
  });

  it('pending() returns null when no pending record exists', () => {
    const { impl } = service();
    expect(impl.pending(CTX)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// promotePending: the internal promotion of a pending second-factor record,
// and the ONE owner of its TTL — `signIn.mfa.pendingTtlMs`.
// ---------------------------------------------------------------------------

describe('AuthSessionService.promotePending', () => {
  /** A controllable clock, so the TTL boundary is exact rather than slept for. */
  function build(ttlMs: number | undefined, start = 1_000) {
    let now = start;
    const session = createFakeSession();
    const impl = new AuthSessionService({
      sessionService: createFakeSessionService(session),
      now: () => now,
      mfa: {
        required: () => true,
        ...(ttlMs === undefined ? {} : { pendingTtlMs: ttlMs }),
      },
    });
    return { impl, session, setNow: (value: number) => (now = value) };
  }

  /** Puts a pending record into the session and returns the service. */
  async function pending(harness: ReturnType<typeof build>) {
    await harness.impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    expect(harness.impl.pending(CTX)).not.toBeNull();
    return harness;
  }

  it('appends the method, rotates the id, and clears the pending record', async () => {
    const harness = await pending(build(300_000));
    // Written AFTER the pending signIn, exactly as a federated callback writes
    // them: they belong to the sign-in being completed.
    harness.session.set(RP_PROVIDER_SESSION_KEY, 'idp');
    harness.session.set(ID_TOKEN_SESSION_KEY, 'id-token');
    harness.session.mutations.length = 0;

    expect(harness.impl.promotePending(CTX, 'otp')).toBe('signed-in');
    expect(harness.session.get(AUTH_SESSION_KEY)).toEqual({
      principal: PRINCIPAL,
      methods: ['pwd', 'otp'],
      at: 1_000,
    });
    expect(harness.session.get(PENDING_MFA_SESSION_KEY)).toBeUndefined();
    // Kept: deleting them would lose RP-initiated logout for every federated
    // sign-in that needed a second factor.
    expect(harness.session.get(RP_PROVIDER_SESSION_KEY)).toBe('idp');
    expect(harness.session.get(ID_TOKEN_SESSION_KEY)).toBe('id-token');
    expect(harness.session.mutations).toEqual([
      `set:${AUTH_SESSION_KEY}`,
      `delete:${PENDING_MFA_SESSION_KEY}`,
      'regenerate',
    ]);
  });

  it("a pending signIn clears an earlier sign-in's provider keys", async () => {
    const harness = build(300_000);
    harness.session.set(RP_PROVIDER_SESSION_KEY, 'idp');
    harness.session.set(ID_TOKEN_SESSION_KEY, 'old-id-token');
    await harness.impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    expect(harness.session.get(RP_PROVIDER_SESSION_KEY)).toBeUndefined();
    expect(harness.session.get(ID_TOKEN_SESSION_KEY)).toBeUndefined();
  });

  it('signIn tolerates a JavaScript caller omitting options', async () => {
    const session = createFakeSession();
    const impl = new AuthSessionService({
      sessionService: createFakeSessionService(session),
      now: () => 5,
    });
    const outcome = await impl.signIn(CTX, PRINCIPAL, undefined as unknown as { methods: [] });
    expect(outcome).toEqual({ status: 'signed-in' });
    expect(session.get(AUTH_SESSION_KEY)).toEqual({ principal: PRINCIPAL, methods: [], at: 5 });
  });

  it('pending() does not report an expired record', async () => {
    const harness = await pending(build(1_000));
    harness.setNow(2_000);
    expect(harness.impl.pending(CTX)?.principal).toEqual(PRINCIPAL);
    harness.setNow(2_001);
    expect(harness.impl.pending(CTX)).toBeNull();
  });

  it('refuses a record older than the configured TTL and deletes it', async () => {
    const harness = await pending(build(1_000));
    harness.setNow(2_001);
    expect(harness.impl.promotePending(CTX, 'otp')).toBe('no-pending');
    // The stale record is gone, so a later attempt cannot resurrect it.
    expect(harness.session.get(PENDING_MFA_SESSION_KEY)).toBeUndefined();
    expect(harness.session.get(AUTH_SESSION_KEY)).toBeUndefined();
    harness.setNow(2_002);
    expect(harness.impl.promotePending(CTX, 'otp')).toBe('no-pending');
  });

  it('honours the TTL boundary inclusively (at the limit is still promotable)', async () => {
    const harness = await pending(build(1_000));
    harness.setNow(2_000);
    expect(harness.impl.promotePending(CTX, 'otp')).toBe('signed-in');
  });

  it('defaults the TTL to 300 000 ms when the option is absent', async () => {
    const harness = await pending(build(undefined));
    // Just inside the default: promotable.
    harness.setNow(1_000 + DEFAULT_PENDING_TTL_MS);
    expect(harness.impl.promotePending(CTX, 'otp')).toBe('signed-in');

    // One millisecond past it: refused. A pendingTtlMs nothing read would make
    // both of these assertions answer the same way.
    const second = await pending(build(undefined));
    second.setNow(1_000 + DEFAULT_PENDING_TTL_MS + 1);
    expect(second.impl.promotePending(CTX, 'otp')).toBe('no-pending');
  });

  it('answers no-pending when nothing is pending', () => {
    const harness = build(300_000);
    expect(harness.impl.promotePending(CTX, 'otp')).toBe('no-pending');
  });

  it('asPendingPromotion narrows the plugin service and refuses one without the seam', () => {
    const harness = build(300_000);
    expect(asPendingPromotion(harness.impl)?.promotePending).toBeInstanceOf(Function);

    // An application's own IAuthSessionService has no promotion to offer.
    const foreign: IAuthSessionService = {
      signIn: () => Promise.resolve({ status: 'signed-in' }),
      current: () => null,
      pending: () => ({ principal: PRINCIPAL, methods: ['pwd'], at: 1_000 }),
      signOut: () => {},
    };
    expect(asPendingPromotion(foreign)).toBeNull();
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

describe('AuthSessionService — scoped grants under sign-in timing (M110b)', () => {
  const GRANT = { role: 'viewer', scope: { type: 'tenant', id: 'acme' } };

  function build(session = createFakeSession(), mfa = false) {
    const impl = new AuthSessionService({
      sessionService: createFakeSessionService(session),
      now: () => NOW,
      scopedGrants: { resolveAll: () => Promise.resolve([GRANT]) },
      ...(mfa ? { mfa: { required: () => true } } : {}),
    });
    return { impl, session };
  }

  it('reads back the grants stored for the signed-in principal', async () => {
    const { impl, session } = build();
    await impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    expect(session.get(SCOPED_GRANTS_SESSION_KEY)).toEqual({ principalId: 'u1', grants: [GRANT] });
    expect(impl.storedGrants(CTX, PRINCIPAL)).toEqual([GRANT]);
  });

  it('never returns grants stored for a different principal', async () => {
    const { impl } = build();
    await impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    expect(impl.storedGrants(CTX, { id: 'someone-else' })).toBeNull();
  });

  it('answers null for a missing, malformed or unreadable stored value', () => {
    const { impl, session } = build();
    expect(impl.storedGrants(CTX, PRINCIPAL)).toBeNull();
    session.set(SCOPED_GRANTS_SESSION_KEY, 'not-an-object');
    expect(impl.storedGrants(CTX, PRINCIPAL)).toBeNull();
    session.set(SCOPED_GRANTS_SESSION_KEY, { principalId: 'u1', grants: 'not-a-list' });
    expect(impl.storedGrants(CTX, PRINCIPAL)).toBeNull();
    // An invalid grant inside an otherwise valid list is dropped, not coerced.
    session.set(SCOPED_GRANTS_SESSION_KEY, { principalId: 'u1', grants: [GRANT, { role: 7 }] });
    expect(impl.storedGrants(CTX, PRINCIPAL)).toEqual([GRANT]);
    const throwing = new AuthSessionService({
      sessionService: {
        from: () => {
          throw new Error('no session middleware');
        },
      } as never,
      now: () => NOW,
      scopedGrants: { resolveAll: () => Promise.resolve([]) },
    });
    expect(throwing.storedGrants(CTX, PRINCIPAL)).toBeNull();
  });

  it('clears stale grants when the promoted pending record carries none', async () => {
    const { impl, session } = build(createFakeSession(), true);
    await impl.signIn(CTX, PRINCIPAL, { methods: ['pwd'] });
    // A pending record written before sign-in timing was configured has no
    // grants field; promotion must not leave an earlier principal's grants.
    session.set(PENDING_MFA_SESSION_KEY, { principal: PRINCIPAL, methods: ['pwd'], at: NOW });
    session.set(SCOPED_GRANTS_SESSION_KEY, { principalId: 'u1', grants: [GRANT] });
    expect(asPendingPromotion(impl)?.promotePending(CTX, 'otp')).toBe('signed-in');
    expect(session.get(SCOPED_GRANTS_SESSION_KEY)).toBeUndefined();
    expect(impl.storedGrants(CTX, PRINCIPAL)).toBeNull();
  });
});

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
