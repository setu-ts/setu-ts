/**
 * Integration — the `auth-session` strategy (plan §3.2): a password login that
 * records its principal through `IAuthSessionService.signIn` authenticates the
 * NEXT request with no hand-added middleware, because M100a's global
 * authentication middleware runs the strategy chain.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPrincipal, IRequest, ISessionService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';

import { AuthPlugin } from '../../src/index.ts';
import { AuthSessionStrategy } from '../../src/strategies/auth-session-strategy.ts';
import { AUTH_SESSION_KEY } from '../../src/sign-in/auth-session-service.ts';
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
            providers: [{
              kind: 'oauth2',
              name: 'gh',
              clientId: 'c',
              authorizationEndpoint: 'https://gh.test/a',
              tokenEndpoint: 'https://gh.test/t',
              userinfoEndpoint: 'https://gh.test/u',
              redirectUri: 'https://app.test/auth/gh/callback',
              toPrincipal: () => null,
            }],
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

  function strategy(data: Record<string, unknown> | null): AuthSessionStrategy {
    const sessionService = {
      fromHeaders: () => Promise.resolve(data === null ? null : { id: 's', data }),
    } as unknown as ISessionService;
    return new AuthSessionStrategy({ sessionService });
  }

  it('is anonymous for an unopenable session and for a session with no record', async () => {
    expect(await strategy(null).authenticate(request)).toBeNull();
    expect(await strategy({}).authenticate(request)).toBeNull();
  });

  it('is anonymous for a corrupted record', async () => {
    expect(await strategy({ [AUTH_SESSION_KEY]: { principal: { id: 7 } } }).authenticate(request))
      .toBeNull();
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
