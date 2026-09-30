/**
 * Sign-in with an outside provider against a REAL Keycloak realm (plan §6).
 *
 * Guarded on `KEYCLOAK_URL` (for example `http://localhost:8180`); the realm,
 * its confidential `setu-web` client and the `alice` user are imported from
 * `test/fixtures/keycloak/setu-realm.json`. The flow is driven headlessly with
 * two cookie jars — the application's session cookie and Keycloak's own — so
 * every hop a browser makes is a real HTTP exchange: login redirect, the
 * provider's login form, the credential POST, the provider's redirect back
 * carrying `code`, `state` and RFC 9207 `iss`, the code exchange over the
 * DEFAULT fetch seam, and ID-token verification against the realm's real keys.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';

import { AuthPlugin, requireAuth } from '../../src/index.ts';
import { CookieJar } from '../fixtures/sign-in-app.ts';

const BASE = Deno.env.get('KEYCLOAK_URL');
const REALM = `${BASE}/realms/setu`;
const POST_LOGOUT = 'http://localhost/signed-out';

async function buildApp(): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: 'keycloak-sign-in-secret-at-least-32-chars', store: 'memory' }),
      AuthPlugin({
        signIn: {
          providers: [{
            kind: 'oidc',
            name: 'keycloak',
            issuer: REALM,
            clientId: 'setu-web',
            clientSecret: 'setu-web-secret',
            scopes: ['openid', 'profile', 'email'],
            redirectUri: 'http://localhost/auth/keycloak/callback',
            toPrincipal: (claims) => ({
              id: `keycloak:${String(claims.sub)}`,
              roles: ['user'],
              claims: { username: claims.preferred_username },
            }),
            rpInitiatedLogout: { postLogoutRedirectUri: POST_LOGOUT, idTokenHint: true },
          }, {
            // The same realm driven as a PLAIN OAuth 2.0 provider: no ID token is
            // read, so the profile must come from userinfo with the access token.
            kind: 'oauth2',
            name: 'keycloak-oauth2',
            clientId: 'setu-web',
            clientSecret: 'setu-web-secret',
            scopes: ['openid'],
            authorizationEndpoint: `${REALM}/protocol/openid-connect/auth`,
            tokenEndpoint: `${REALM}/protocol/openid-connect/token`,
            userinfoEndpoint: `${REALM}/protocol/openid-connect/userinfo`,
            redirectUri: 'http://localhost/auth/keycloak-oauth2/callback',
            toPrincipal: (profile) => ({
              id: `keycloak-oauth2:${String(profile.sub)}`,
              claims: { username: profile.preferred_username },
            }),
          }],
        },
      }),
    ],
  });
  app.router.get('/me', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json({ user: ctx.request.user }),
  });
  await app.start();
  return app;
}

/** A minimal browser-side cookie jar for Keycloak's own session cookies. */
class ProviderJar {
  readonly #cookies = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) {
      headers.set(
        'cookie',
        [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const index = pair.indexOf('=');
      this.#cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
}

/** Decodes the few HTML entities Keycloak writes into a form `action`. */
function unescapeHtml(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&#x3D;', '=').replaceAll('&quot;', '"');
}

/** Logs `alice` in at Keycloak and returns the redirect back to the application. */
async function providerLogin(authorize: string, providerJar: ProviderJar): Promise<URL> {
  const formPage = await providerJar.fetch(authorize);
  const html = await formPage.text();
  const form = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html);
  if (form === null) throw new Error('Keycloak login form not found');
  const submitted = await providerJar.fetch(unescapeHtml(form[1]), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'alice', password: 'alice-password' }).toString(),
  });
  return new URL(submitted.headers.get('location') ?? '');
}

describe('Keycloak sign-in (real)', { ignore: BASE === undefined }, () => {
  it('signs a user in through the oauth2 arm, reading userinfo with the access token', async () => {
    const app = await buildApp();
    try {
      const appJar = new CookieJar();
      const login = await appJar.fetch(app, '/auth/keycloak-oauth2/login');
      const back = await providerLogin(login.headers.get('location') ?? '', new ProviderJar());
      const done = await appJar.fetch(app, `${back.pathname}${back.search}`);
      expect(done.status).toBe(302);
      const me = await appJar.fetch(app, '/me');
      expect(me.status).toBe(200);
      const user = ((await me.json()) as { user: Record<string, unknown> }).user;
      expect(String(user.id).startsWith('keycloak-oauth2:')).toBe(true);
      expect(user.claims).toEqual({ username: 'alice', amr: ['fed'] });
    } finally {
      await app.stop();
    }
  });

  it('signs a user in through the real login form and serves a protected route', async () => {
    const app = await buildApp();
    try {
      const appJar = new CookieJar();
      const providerJar = new ProviderJar();

      // 1. The application redirects to the realm's discovered authorize URL.
      const login = await appJar.fetch(app, '/auth/keycloak/login?returnTo=/me');
      expect(login.status).toBe(302);
      const authorize = login.headers.get('location') ?? '';
      expect(authorize.startsWith(`${REALM}/protocol/openid-connect/auth?`)).toBe(true);

      // 2. Keycloak renders its login form, found by its stable id.
      const formPage = await providerJar.fetch(authorize);
      expect(formPage.status).toBe(200);
      const html = await formPage.text();
      const form = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html);
      if (form === null) throw new Error('Keycloak login form not found');

      // 3. The credentials are posted; Keycloak redirects back with a code.
      const submitted = await providerJar.fetch(unescapeHtml(form[1]), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'alice', password: 'alice-password' }).toString(),
      });
      expect(submitted.status).toBe(302);
      const back = new URL(submitted.headers.get('location') ?? '');
      expect(`${back.origin}${back.pathname}`).toBe('http://localhost/auth/keycloak/callback');
      expect(back.searchParams.has('code')).toBe(true);
      // Keycloak 26 sends RFC 9207 `iss`, so the mix-up check runs for real.
      expect(back.searchParams.get('iss')).toBe(REALM);

      // 4. The callback exchanges the code, verifies the ID token and signs in.
      const done = await appJar.fetch(app, `${back.pathname}${back.search}`);
      expect(done.status).toBe(302);
      expect(done.headers.get('location')).toBe('/me');

      const me = await appJar.fetch(app, '/me');
      expect(me.status).toBe(200);
      const user = ((await me.json()) as { user: Record<string, unknown> }).user;
      expect(String(user.id).startsWith('keycloak:')).toBe(true);
      expect(user.claims).toEqual({ username: 'alice', amr: ['fed'] });

      // 5. A replayed callback fails: the state entry and the code are both spent.
      const replay = await appJar.fetch(app, `${back.pathname}${back.search}`);
      expect(replay.status).toBe(401);
      await replay.body?.cancel();

      // 6. RP-initiated logout with id_token_hint: Keycloak accepts it and
      //    redirects to the registered post-logout URI without a confirmation.
      const logout = await appJar.fetch(app, '/auth/logout', { method: 'POST' });
      const endSession = logout.headers.get('location') ?? '';
      expect(endSession.startsWith(`${REALM}/protocol/openid-connect/logout?`)).toBe(true);
      const ended = await providerJar.fetch(endSession);
      expect(ended.status).toBe(302);
      expect(ended.headers.get('location')).toBe(POST_LOGOUT);
      expect((await appJar.fetch(app, '/me')).status).toBe(401);
    } finally {
      await app.stop();
    }
  });
});
