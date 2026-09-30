/**
 * Integration — the sign-in logout route (plan §3.4, §3.8).
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  buildSignInApp,
  callback,
  CLIENT_ID,
  CookieJar,
  discoveryDocument,
  followLogin,
  ISSUER,
  json,
} from '../fixtures/sign-in-app.ts';
import type { BuildOptions, SignInHarness } from '../fixtures/sign-in-app.ts';

const POST_LOGOUT = 'http://localhost/signed-out';

describe('sign-in logout route', () => {
  let harness: SignInHarness;
  let jar: CookieJar;

  async function signedIn(options: BuildOptions = {}): Promise<void> {
    harness = await buildSignInApp(options);
    jar = new CookieJar();
    const params = await followLogin(harness, jar);
    const response = await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' });
    expect(response.status).toBe(302);
    expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
  }

  afterEach(async () => {
    await harness.app.stop();
  });

  it('ends the local session and redirects to /', async () => {
    await signedIn();
    const response = await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
  });

  it('on the store strategy, a cookie copied before logout is anonymous afterwards', async () => {
    await signedIn({ session: { store: 'memory' } });
    const copied = jar.cookie;
    await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    const replay = await harness.app.fetch(
      new Request('http://localhost/me', { headers: { cookie: copied ?? '' } }),
    );
    expect(replay.status).toBe(401);
    await replay.body?.cancel();
  });

  it('redirects to the end-session endpoint without id_token_hint by default', async () => {
    await signedIn({ oidc: { rpInitiatedLogout: { postLogoutRedirectUri: POST_LOGOUT } } });
    const session = JSON.stringify(await json(await jar.fetch(harness.app, '/_session')));
    // Not stored unless opted in: it would consume the cookie's budget.
    expect(session).not.toContain('eyJ');
    const response = await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/logout`);
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(POST_LOGOUT);
    expect(location.searchParams.has('id_token_hint')).toBe(false);
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
  });

  it('sends the stored ID token as id_token_hint when opted in', async () => {
    await signedIn({
      session: { store: 'memory' },
      oidc: { rpInitiatedLogout: { postLogoutRedirectUri: POST_LOGOUT, idTokenHint: true } },
    });
    const idToken = (harness.tokens[0] as { idToken: string }).idToken;
    const response = await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('id_token_hint')).toBe(idToken);
  });

  it('falls back to / when discovery advertises no end-session endpoint', async () => {
    const { end_session_endpoint: _dropped, ...withoutEndSession } = discoveryDocument();
    await signedIn({
      oidc: { rpInitiatedLogout: { postLogoutRedirectUri: POST_LOGOUT } },
      discovery: withoutEndSession,
    });
    const response = await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    expect(response.headers.get('location')).toBe('/');
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
  });

  it('joins an end-session endpoint that already carries a query with & (M100c F6)', async () => {
    await signedIn({
      oidc: { rpInitiatedLogout: { postLogoutRedirectUri: POST_LOGOUT } },
      discovery: discoveryDocument({ end_session_endpoint: `${ISSUER}/logout?ui=1` }),
    });
    const response = await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    const location = response.headers.get('location') ?? '';
    expect(location.startsWith(`${ISSUER}/logout?ui=1&client_id=`)).toBe(true);
    expect(location.split('?').length).toBe(2);
  });

  it('ends only the local session for a sign-in that did not come through that provider', async () => {
    const rp = { oidc: { rpInitiatedLogout: { postLogoutRedirectUri: POST_LOGOUT } } };
    // A password sign-in, and an anonymous POST, are never sent to the provider.
    harness = await buildSignInApp(rp);
    jar = new CookieJar();
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    let response = await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    expect(response.headers.get('location')).toBe('/');
    response = await new CookieJar().fetch(harness.app, '/auth/logout', { method: 'POST' });
    expect(response.headers.get('location')).toBe('/');
    await harness.app.stop();

    // A federated sign-in followed by a password sign-in in the SAME session
    // does not inherit the provider session, nor its ID token.
    await signedIn({
      session: { store: 'memory' },
      oidc: { rpInitiatedLogout: { postLogoutRedirectUri: POST_LOGOUT, idTokenHint: true } },
    });
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    response = await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    expect(response.headers.get('location')).toBe('/');
  });

  it('with form CSRF configured, refuses a logout without the token and accepts one with it', async () => {
    await signedIn({ session: { csrf: {} } });
    const refused = await jar.fetch(harness.app, '/auth/logout', { method: 'POST' });
    expect(refused.status).toBe(403);
    await refused.body?.cancel();
    expect((await jar.fetch(harness.app, '/me')).status).toBe(200);

    const token = (await json(await jar.fetch(harness.app, '/_csrf'))).token as string;
    const accepted = await jar.fetch(harness.app, '/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: token }).toString(),
    });
    expect(accepted.status).toBe(302);
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
  });
});
