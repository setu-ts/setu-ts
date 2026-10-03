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
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';

import { AuthPlugin, requireAuth } from '../../src/index.ts';
import { MultiCookieJar, postAcs } from '../fixtures/saml-idp.ts';
import type { SamlHarness } from '../fixtures/saml-idp.ts';

const BASE = Deno.env.get('KEYCLOAK_URL');
const REALM = `${BASE}/realms/setu`;
const NAME = 'keycloak-saml';

async function realmCert(): Promise<string> {
  const descriptor = await (await fetch(`${REALM}/protocol/saml/descriptor`)).text();
  const match = /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/.exec(descriptor);
  if (match === null) throw new Error('no signing certificate in the realm descriptor');
  return `-----BEGIN CERTIFICATE-----\n${match[1]}\n-----END CERTIFICATE-----\n`;
}

async function buildApp(): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: 'keycloak-saml-session-secret-at-least-32', store: 'memory' }),
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
});
