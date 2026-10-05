/**
 * SAML 2.0 sign-in against a REAL Keycloak realm (M100f plan §6).
 *
 * Guarded on `KEYCLOAK_URL` (for example `http://localhost:8180`); the realm's
 * `https://sp.setu.test` SAML client and the `alice` user are imported from
 * `test/fixtures/keycloak/setu-realm.json`. The IdP's signing certificate is
 * read from the realm's own SAML descriptor at test time, because Keycloak
 * generates the realm keys on import. The flow is driven headlessly: the SP's
 * Redirect-binding AuthnRequest, Keycloak's login form, the credential POST,
 * Keycloak's auto-submitting POST-binding form, and the ACS — verified by the
 * real node-saml against the realm's real key.
 *
 * M101c (V8-9) adds the CSRF composition against the REAL IdP: Keycloak serves
 * `Referrer-Policy: no-referrer`, so a real browser posts the ACS with
 * `Origin: null`. The documented recipe — the ACS path in BOTH the session
 * plugin's form-CSRF `exclude` and `HttpSecurityPlugin`'s CSRF `exclude` —
 * signs in under that post; the same post without the exclusions answers `403`.
 * This harness has no headless browser of its own, so the `Origin: null` header
 * is synthesised exactly as the browser sends it; the unit-level fourth cell in
 * `saml-csrf-composition.test.ts` carries the same reproduction without a live
 * IdP.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import type { CsrfOptions } from '@setu-ts/http-security-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';
import type { CsrfFormOptions } from '@setu-ts/session-plugin';

import { AuthPlugin, requireAuth } from '../../src/index.ts';
import { SAML_BINDING_COOKIE } from '../../src/saml/binding-cookie.ts';
import { MultiCookieJar, postAcs } from '../fixtures/saml-idp.ts';
import type { SamlHarness } from '../fixtures/saml-idp.ts';

const BASE = Deno.env.get('KEYCLOAK_URL');
const REALM = `${BASE}/realms/setu`;
const NAME = 'keycloak-saml';
const ACS_PATH = `/auth/${NAME}/acs`;

async function realmCert(): Promise<string> {
  const descriptor = await (await fetch(`${REALM}/protocol/saml/descriptor`)).text();
  const match = /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/.exec(descriptor);
  if (match === null) throw new Error('no signing certificate in the realm descriptor');
  return `-----BEGIN CERTIFICATE-----\n${match[1]}\n-----END CERTIFICATE-----\n`;
}

/** The two CSRF option blocks the composition tests drive. */
interface CsrfComposition {
  readonly session: CsrfFormOptions;
  readonly http: CsrfOptions;
}

async function buildApp(csrf?: CsrfComposition): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ...(csrf === undefined ? [] : [HttpSecurityPlugin({ csrf: csrf.http })]),
      SessionPlugin({
        secret: 'keycloak-saml-session-secret-at-least-32',
        store: 'memory',
        ...(csrf === undefined ? {} : { csrf: csrf.session }),
      }),
      AuthPlugin({
        signIn: {
          providers: [{
            kind: 'saml',
            name: NAME,
            entityId: 'https://sp.setu.test',
            idp: {
              entityId: REALM,
              ssoUrl: `${REALM}/protocol/saml`,
              certs: [await realmCert()],
            },
            acsUrl: `http://localhost/auth/${NAME}/acs`,
            toPrincipal: (profile) => ({
              id: `keycloak-saml:${profile.nameID}`,
              claims: { email: profile.attributes.email },
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

/** Keycloak's own cookies, kept apart from the application's. */
class ProviderJar {
  readonly #cookies = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) {
      headers.set('cookie', [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; '));
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

function unescapeHtml(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&#x3D;', '=').replaceAll('&quot;', '"');
}

/** Logs `alice` in at Keycloak and returns the auto-posted SAMLResponse. */
async function providerLogin(authnRequestUrl: string): Promise<string> {
  const jar = new ProviderJar();
  const page = await jar.fetch(authnRequestUrl);
  expect(page.status).toBe(200);
  const form = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(await page.text());
  if (form === null) throw new Error('Keycloak login form not found');
  const submitted = await jar.fetch(unescapeHtml(form[1]), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'alice', password: 'alice-password' }).toString(),
  });
  const html = await submitted.text();
  const value = /name="SAMLResponse"\s+value="([^"]+)"/.exec(html);
  if (value === null) throw new Error(`no SAMLResponse in Keycloak's answer (${submitted.status})`);
  return unescapeHtml(value[1]);
}

describe('Keycloak SAML sign-in (real)', { ignore: BASE === undefined }, () => {
  it('signs a user in through the real IdP and refuses a replay', async () => {
    const app = await buildApp();
    try {
      const harness = { app } as SamlHarness;
      const jar = new MultiCookieJar();

      // 1. SP-initiated login over the Redirect binding.
      const login = await jar.fetch(app, `/auth/${NAME}/login?returnTo=/me`);
      expect(login.status).toBe(302);
      const authn = login.headers.get('location') ?? '';
      expect(authn.startsWith(`${REALM}/protocol/saml?SAMLRequest=`)).toBe(true);

      // 2-3. Keycloak's login form, then its POST-binding form back to the ACS.
      const samlResponse = await providerLogin(authn);

      // 4. The ACS verifies against the realm's real key and signs in.
      const done = await postAcs(harness, jar, samlResponse, {}, NAME);
      expect(done.status).toBe(302);
      expect(done.headers.get('location')).toBe('/me');
      const me = await jar.fetch(app, '/me');
      expect(me.status).toBe(200);
      const user = ((await me.json()) as { user: Record<string, unknown> }).user;
      expect(user.id).toBe('keycloak-saml:alice');
      expect(user.claims).toEqual({ email: 'alice@example.test', amr: ['fed'] });

      // 5. The captured response cannot be posted again.
      const replay = await postAcs(harness, new MultiCookieJar(), samlResponse, {}, NAME);
      expect(replay.status).toBe(401);
      await replay.body?.cancel();
    } finally {
      await app.stop();
    }
  });

  /**
   * Posts as a browser returning from the IdP does: only the
   * `SameSite=None` binding cookie accompanies a cross-site POST, and
   * Keycloak's `Referrer-Policy: no-referrer` makes the browser send
   * `Origin: null`. The browser keeps whatever the ACS sets alongside its
   * existing cookies.
   */
  async function crossSitePost(
    harness: SamlHarness,
    jar: MultiCookieJar,
    body: string,
  ): Promise<Response> {
    const crossSite = new MultiCookieJar();
    crossSite.cookies.set(SAML_BINDING_COOKIE, jar.cookies.get(SAML_BINDING_COOKIE) ?? '');
    const response = await postAcs(harness, crossSite, body, { origin: 'null' }, NAME);
    crossSite.cookies.delete(SAML_BINDING_COOKIE);
    jar.cookies.delete(SAML_BINDING_COOKIE);
    for (const [name, value] of crossSite.cookies) {
      jar.cookies.set(name, value);
    }
    return response;
  }

  it('signs in with the documented exclude recipe under a real Origin: null post (M101c, V8-9)', async () => {
    // Keycloak serves `Referrer-Policy: no-referrer`, so a real browser posts
    // the ACS with `Origin: null`. The documented recipe — the ACS path in
    // BOTH the session plugin's form-CSRF `exclude` and http-security's CSRF
    // `exclude` — signs in, because the excluded path is checked before any
    // origin is inspected.
    const app = await buildApp({
      session: { exclude: [ACS_PATH] },
      http: { exclude: [ACS_PATH] },
    });
    try {
      const harness = { app } as SamlHarness;
      const jar = new MultiCookieJar();
      const login = await jar.fetch(app, `/auth/${NAME}/login?returnTo=/me`);
      expect(login.status).toBe(302);
      const authn = login.headers.get('location') ?? '';
      const samlResponse = await providerLogin(authn);
      const done = await crossSitePost(harness, jar, samlResponse);
      expect(done.status).toBe(302);
      expect(done.headers.get('location')).toBe('/me');
      const me = await jar.fetch(app, '/me');
      expect(me.status).toBe(200);
      const user = ((await me.json()) as { user: Record<string, unknown> }).user;
      expect(user.id).toBe('keycloak-saml:alice');
    } finally {
      await app.stop();
    }
  });

  it('refuses the Origin: null post without the exclusions (M101c, V8-9)', async () => {
    // The same real post, with neither CSRF check exempting the ACS: the
    // http-security Origin check sees `Origin: null`, which no origin
    // allowlist admits, and answers 403 — the reproduction that motivated
    // the `exclude` option.
    const app = await buildApp({ session: {}, http: {} });
    try {
      const harness = { app } as SamlHarness;
      const jar = new MultiCookieJar();
      const login = await jar.fetch(app, `/auth/${NAME}/login?returnTo=/me`);
      expect(login.status).toBe(302);
      const authn = login.headers.get('location') ?? '';
      const samlResponse = await providerLogin(authn);
      const refused = await crossSitePost(harness, jar, samlResponse);
      expect(refused.status).toBe(403);
      await refused.body?.cancel();
    } finally {
      await app.stop();
    }
  });
});
