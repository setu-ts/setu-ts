/**
 * Integration — a federated sign-in that needs a second factor (plan §3.7).
 *
 * The provider callback records its principal through `signIn`, which holds it
 * pending when `mfa.required` answers `true`. The callback must then send the
 * browser to the code form rather than to `returnTo`, and the provider-session
 * facts it records must survive the promotion that completes the sign-in — or
 * RP-initiated logout is lost for every federated user who needed a second
 * factor.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IRuntimeServices } from '@setu-ts/common';

import { MemoryTotpStore, TotpService } from '../../src/index.ts';
import { decodeBase32 } from '../../src/mfa/base32.ts';
import { computeTotpCode, totpCounter } from '../../src/mfa/totp-codes.ts';
import {
  buildSignInApp,
  callback,
  CookieJar,
  followLogin,
  ISSUER,
  json,
} from '../fixtures/sign-in-app.ts';
import type { BuildOptions, SignInHarness } from '../fixtures/sign-in-app.ts';

const POST_LOGOUT = 'http://localhost/signed-out';
/** The principal the fixture's `toPrincipal` builds for `sub: 'user-1'`. */
const PRINCIPAL_ID = 'idp:user-1';

describe('federated sign-in with a second factor', () => {
  let harness: SignInHarness;
  const store = new MemoryTotpStore();

  /** Registers the code-form route a real application would own. */
  const codeForm: IPlugin = {
    name: 'code-form',
    version: '0.0.0',
    dependencies: [CAPABILITIES.AUTH_SESSION],
    register(ctx) {
      ctx.router.post('/mfa/complete', async (request) => {
        const runtime = request.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
        const { code } = await request.request.json<{ code: string }>();
        const service = new TotpService({ store, runtime, issuer: 'Test' });
        return request.response.json({ result: await service.completeSignIn(request, code) });
      });
    },
  };

  async function build(options: BuildOptions): Promise<CookieJar> {
    harness = await buildSignInApp({ ...options, plugins: [codeForm] });
    return new CookieJar();
  }

  async function federate(jar: CookieJar, returnTo = '/dashboard'): Promise<Response> {
    const params = await followLogin(harness, jar, 'idp', `?returnTo=${returnTo}`);
    return await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' });
  }

  afterEach(async () => {
    await harness.app.stop();
  });

  it('redirects to the configured challengePath and stays anonymous', async () => {
    const jar = await build({ signIn: { mfa: { required: () => true, challengePath: '/mfa' } } });
    const response = await federate(jar);
    await response.body?.cancel();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/mfa');
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
  });

  it('falls back to returnTo when no challengePath is configured', async () => {
    const jar = await build({ signIn: { mfa: { required: () => true } } });
    const response = await federate(jar);
    await response.body?.cancel();
    expect(response.headers.get('location')).toBe('/dashboard');
  });

  it('a sign-in that needs no second factor still lands on returnTo', async () => {
    const jar = await build({ signIn: { mfa: { required: () => false, challengePath: '/mfa' } } });
    const response = await federate(jar);
    await response.body?.cancel();
    expect(response.headers.get('location')).toBe('/dashboard');
    expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
  });

  it('keeps RP-initiated logout across the promotion that completes the sign-in', async () => {
    const jar = await build({
      session: { store: 'memory' },
      oidc: { rpInitiatedLogout: { postLogoutRedirectUri: POST_LOGOUT, idTokenHint: true } },
      signIn: { mfa: { required: () => true, challengePath: '/mfa' } },
    });

    // Enrol the federated principal directly against the store the form uses.
    const enrol = new TotpService({ store, runtime: rt(), issuer: 'Test' });
    const { secret } = await enrol.beginEnrolment(PRINCIPAL_ID, 'user-1');
    const step = totpCounter(rt().now());
    expect(await enrol.confirmEnrolment(PRINCIPAL_ID, await codeAt(secret, step - 1)))
      .toBe('ok');

    (await federate(jar)).body?.cancel();
    const completed = await json(
      await jar.fetch(harness.app, '/mfa/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: await codeAt(secret, step) }),
      }),
    );
    expect(completed.result).toBe('signed-in');
    const me = await json(await jar.fetch(harness.app, '/me'));
    expect((me.user as { claims: { amr: string[] } }).claims.amr).toEqual(['fed', 'otp']);

    // The provider session recorded by the callback is still there to end.
    const idToken = (harness.tokens[0] as { idToken: string }).idToken;
    const response = await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/logout`);
    expect(location.searchParams.get('id_token_hint')).toBe(idToken);
  });

  /** The application's runtime, so codes are computed on the clock it verifies with. */
  function rt(): IRuntimeServices {
    return harness.app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  }

  async function codeAt(secret: string, step: number): Promise<string> {
    return await computeTotpCode(rt().subtle, decodeBase32(secret), step);
  }
});
