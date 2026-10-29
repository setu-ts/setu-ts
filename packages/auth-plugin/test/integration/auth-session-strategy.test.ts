/**
 * Integration — the `auth-session` strategy (plan §3.2): a password login that
 * records its principal through `IAuthSessionService.signIn` authenticates the
 * NEXT request with no hand-added middleware, because M100a's global
 * authentication middleware runs the strategy chain.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPrincipal, IRequest, ISessionService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';

import { AuthPlugin } from '../../src/index.ts';
import { AuthSessionStrategy } from '../../src/strategies/auth-session-strategy.ts';
import { AUTH_SESSION_KEY } from '../../src/sign-in/auth-session-service.ts';
import type { SessionStamp } from '../../src/interfaces/index.ts';
import { buildSignInApp, CookieJar, json } from '../fixtures/sign-in-app.ts';
import type { BuildOptions, SignInHarness } from '../fixtures/sign-in-app.ts';

describe('auth-session strategy', () => {
  let harness: SignInHarness;
  let jar: CookieJar;

  async function passwordLogin(options: BuildOptions = {}): Promise<void> {
    harness = await buildSignInApp(options);
    jar = new CookieJar();
    const response = await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }

  afterEach(async () => {
    await harness.app.stop();
  });

  it('authenticates the next request, with amr from the record overwriting the principal', async () => {
    await passwordLogin();
    const me = await json(await jar.fetch(harness.app, '/me'));
    // The stored principal claimed amr ['hwk']; the record's methods win.
    expect(me.user).toEqual({ id: 'alice', roles: ['user'], claims: { amr: ['pwd'] } });
  });

  it('is anonymous with no session, and after sign-out', async () => {
    await passwordLogin();
    expect((await harness.app.fetch(new Request('http://localhost/me'))).status).toBe(401);
    await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
  });

  it('makes the request anonymous when refreshPrincipal returns null (revocation)', async () => {
    await passwordLogin({ signIn: { refreshPrincipal: () => null } });
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
  });

  it('uses the principal refreshPrincipal returns, keeping the recorded amr', async () => {
    const seen: IPrincipal[] = [];
    await passwordLogin({
      signIn: {
        refreshPrincipal: (stored) => {
          seen.push(stored);
          return Promise.resolve({ id: stored.id, roles: ['admin'] });
        },
      },
    });
    const me = await json(await jar.fetch(harness.app, '/me'));
    expect(me.user).toEqual({ id: 'alice', roles: ['admin'], claims: { amr: ['pwd'] } });
    expect(seen[0].id).toBe('alice');
  });

  it('fails closed — anonymous, never the stale snapshot — when refreshPrincipal throws', async () => {
    await passwordLogin({
      signIn: {
        refreshPrincipal: () => {
          throw new Error('identity store down');
        },
      },
    });
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
  });

  it('re-checks a password-only sign-in with no provider (V10-65)', async () => {
    // M124 §3.1: `providers: []` without mfa or passkeys is accepted, and the
    // per-request re-read still runs.
    let active = true;
    await passwordLogin({
      signIn: { providers: [], refreshPrincipal: (stored) => (active ? stored : null) },
    });
    expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
    active = false;
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
    // Only the logout route is registered for an empty provider list.
    const login = await harness.app.fetch(new Request('http://localhost/auth/idp/login'));
    expect(login.status).toBe(404);
    await login.body?.cancel();
  });

  describe('session stamp (M124 §3.3)', () => {
    it('ends the session when the user stamp changes, and keeps it while it matches', async () => {
      let stamp: string | null = 'v1';
      await passwordLogin({ signIn: { providers: [], sessionStamp: () => stamp } });
      expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
      expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
      stamp = 'v2';
      expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
      stamp = null;
      expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
    });

    it('matches a user with no stamp only while the user still has none', async () => {
      let stamp: string | null = null;
      await passwordLogin({ signIn: { providers: [], sessionStamp: () => stamp } });
      expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
      stamp = 'v1';
      expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
    });

    it('fails closed when the reader throws or returns a non-string', async () => {
      let mode: 'ok' | 'throw' | 'number' = 'ok';
      await passwordLogin({
        signIn: {
          providers: [],
          sessionStamp: () => {
            if (mode === 'throw') {
              throw new Error('user store down');
            }
            return mode === 'number' ? (7 as unknown as string) : 'v1';
          },
        },
      });
      expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
      mode = 'throw';
      expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
      mode = 'number';
      expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
      mode = 'ok';
      expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
    });

    it('reads the stamp from the principal refreshPrincipal returned, after the re-read', async () => {
      const users = new Map([['alice', { version: 'v1', active: true }]]);
      const order: string[] = [];
      await passwordLogin({
        signIn: {
          providers: [],
          refreshPrincipal: (stored) => {
            order.push('refresh');
            const user = users.get(stored.id);
            return user?.active === true
              ? { id: stored.id, roles: ['user'], claims: { sessionVersion: user.version } }
              : null;
          },
          sessionStamp: (principal) => {
            order.push('stamp');
            // At sign-in the fixture's principal carries no claim: read the record.
            const claim = principal.claims?.sessionVersion;
            return typeof claim === 'string' ? claim : (users.get(principal.id)?.version ?? null);
          },
        },
      });
      order.length = 0;
      const me = await json(await jar.fetch(harness.app, '/me'));
      expect(me.user).toEqual({
        id: 'alice',
        roles: ['user'],
        claims: { sessionVersion: 'v1', amr: ['pwd'] },
      });
      expect(order).toEqual(['refresh', 'stamp']);
      users.set('alice', { version: 'v2', active: true });
      expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
      // A revoked principal is anonymous before the stamp is ever read.
      users.set('alice', { version: 'v1', active: false });
      order.length = 0;
      expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
      expect(order).toEqual(['refresh']);
    });

    it('keeps the current session through a re-sign-in after a bump', async () => {
      let stamp = 'v1';
      await passwordLogin({ signIn: { providers: [], sessionStamp: () => stamp } });
      stamp = 'v2';
      expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
      // The application's password-change handler signs the session in again.
      await jar.fetch(harness.app, '/password-login', { method: 'POST' });
      expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
    });
  });

  it('the session id held before a password sign-in no longer carries an identity (store)', async () => {
    harness = await buildSignInApp({ session: { store: 'memory' } });
    jar = new CookieJar();
    // Plant a pre-authentication session, as a fixation attacker would.
    await jar.fetch(harness.app, '/auth/idp/login');
    const planted = jar.cookie;
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    expect(jar.cookie).not.toBe(planted);
    const replay = await harness.app.fetch(
      new Request('http://localhost/me', { headers: { cookie: planted ?? '' } }),
    );
    expect(replay.status).toBe(401);
    await replay.body?.cancel();
  });

  it('refuses at register() when the session plugin is absent, naming both plugins', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({
          apiKey: { validate: () => Promise.resolve(null) },
          signIn: {
            providers: [
              {
                kind: 'oauth2',
                name: 'gh',
                clientId: 'c',
                authorizationEndpoint: 'https://gh.test/a',
                tokenEndpoint: 'https://gh.test/t',
                userinfoEndpoint: 'https://gh.test/u',
                redirectUri: 'https://app.test/auth/gh/callback',
                toPrincipal: () => null,
              },
            ],
          },
        }),
      ],
    });
    await expect(app.start()).rejects.toThrow(
      /signIn requires the session capability.*SessionPlugin/,
    );
    harness = await buildSignInApp();
  });

  it('provides auth-session only when signIn is configured', async () => {
    harness = await buildSignInApp();
    expect(harness.app.services.has(CAPABILITIES.AUTH_SESSION)).toBe(true);
    const plain = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({ secret: 'plain-session-secret-at-least-32-characters' }),
        AuthPlugin({ apiKey: { validate: () => Promise.resolve(null) } }),
      ],
    });
    await plain.start();
    expect(plain.services.has(CAPABILITIES.AUTH_SESSION)).toBe(false);
    await plain.stop();
  });
});

describe('AuthSessionStrategy edge cases', () => {
  const request = { headers: new Headers() } as IRequest;

  /**
   * A strategy over a fake session holding `data`, with the stamp check when
   * `sessionStamp` is given.
   */
  function strategy(
    data: Record<string, unknown> | null,
    sessionStamp?: SessionStamp,
  ): AuthSessionStrategy {
    const sessionService = {
      fromHeaders: () => Promise.resolve(data === null ? null : { id: 's', data }),
    } as unknown as ISessionService;
    return new AuthSessionStrategy({
      sessionService,
      ...(sessionStamp === undefined
        ? {}
        : { sessionStamp: { read: sessionStamp, subtle: crypto.subtle } }),
    });
  }

  it('reads a record written before sessionStamp was configured as having no stamp', async () => {
    const legacy = { [AUTH_SESSION_KEY]: { principal: { id: 'u' }, methods: ['pwd'], at: 1 } };
    expect((await strategy(legacy, () => null).authenticate(request))?.id).toBe('u');
    expect(await strategy(legacy, () => 'v1').authenticate(request)).toBeNull();
  });

  it('compares the digest, so a record holding the raw stamp does not match', async () => {
    const raw = {
      [AUTH_SESSION_KEY]: { principal: { id: 'u' }, methods: ['pwd'], at: 1, stamp: 'v1' },
    };
    expect(await strategy(raw, () => 'v1').authenticate(request)).toBeNull();
    const hashed = {
      [AUTH_SESSION_KEY]: {
        principal: { id: 'u' },
        methods: ['pwd'],
        at: 1,
        stamp: createHash('sha256').update('v1').digest('base64url'),
      },
    };
    expect((await strategy(hashed, () => 'v1').authenticate(request))?.id).toBe('u');
  });

  it('is anonymous for a record whose stamp is not a string', async () => {
    const corrupt = {
      [AUTH_SESSION_KEY]: { principal: { id: 'u' }, methods: ['pwd'], at: 1, stamp: 7 },
    };
    expect(await strategy(corrupt).authenticate(request)).toBeNull();
  });

  it('is anonymous for an unopenable session and for a session with no record', async () => {
    expect(await strategy(null).authenticate(request)).toBeNull();
    expect(await strategy({}).authenticate(request)).toBeNull();
  });

  it('is anonymous for a corrupted record', async () => {
    expect(
      await strategy({ [AUTH_SESSION_KEY]: { principal: { id: 7 } } }).authenticate(request),
    ).toBeNull();
  });

  it('freezes the principal it returns so no later code can upgrade its amr', async () => {
    const principal = await strategy({
      [AUTH_SESSION_KEY]: { principal: { id: 'u' }, methods: ['otp'], at: 1 },
    }).authenticate(request);
    expect(principal?.claims?.amr).toEqual(['otp']);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal?.claims)).toBe(true);
    expect(Object.isFrozen(principal?.claims?.amr)).toBe(true);
  });
});
