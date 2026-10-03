/**
 * The ACS composed with both CSRF defences (M100f plan §3.7), and the
 * session it lands in (§3.6).
 *
 * The IdP's cross-site `POST` carries no form token and an `Origin` naming the
 * IdP, so the session plugin's form CSRF and http-security's Origin check each
 * answer `403` unless the documented configuration — the ACS path in
 * `CsrfFormOptions.exclude` and the IdP origin in `trustedOrigins` — is
 * applied. Both halves are driven: refused without it, signed in with it.
 *
 * @module
 */
import { afterEach, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';

import {
  buildSamlApp,
  generateSigningKey,
  MultiCookieJar,
  postAcs,
  PROVIDER,
  signedResponse,
  startLogin,
} from '../fixtures/saml-idp.ts';
import type { SamlAppOptions, SamlHarness, TestSigningKey } from '../fixtures/saml-idp.ts';
import { SAML_BINDING_COOKIE } from '../../src/saml/binding-cookie.ts';

const IDP_ORIGIN = 'https://idp.test';
const ACS_PATH = `/auth/${PROVIDER}/acs`;

let key: TestSigningKey;
let harness: SamlHarness | undefined;

beforeAll(async () => {
  key = await generateSigningKey();
});

afterEach(async () => {
  await harness?.app.stop();
  harness = undefined;
});

function composed(documented: boolean): SamlAppOptions {
  return {
    session: { csrf: documented ? { exclude: [ACS_PATH] } : {} },
    plugins: [
      HttpSecurityPlugin({
        csrf: documented ? { trustedOrigins: [IDP_ORIGIN] } : {},
      }),
    ],
  };
}

/**
 * Posts as a browser returning from the IdP does: the `Lax` session cookie is
 * NOT sent on a cross-site POST, the `SameSite=None` binding cookie is.
 */
async function crossSitePost(jar: MultiCookieJar, body: string): Promise<Response> {
  const crossSite = new MultiCookieJar();
  crossSite.cookies.set(SAML_BINDING_COOKIE, jar.cookies.get(SAML_BINDING_COOKIE) ?? '');
  const response = await postAcs(harness!, crossSite, body, { origin: IDP_ORIGIN });
  // The browser keeps whatever the ACS set, alongside its existing cookies.
  crossSite.cookies.delete(SAML_BINDING_COOKIE);
  jar.cookies.delete(SAML_BINDING_COOKIE);
  for (const [name, value] of crossSite.cookies) {
    jar.cookies.set(name, value);
  }
  return response;
}

describe('SAML ACS with both CSRF defences', () => {
  it('answers 403 without the documented exclude and trustedOrigins', async () => {
    harness = await buildSamlApp(key, composed(false));
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar);
    const response = await crossSitePost(jar, signedResponse(key, requestId));
    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  it('answers 403 with only one of the two settings', async () => {
    harness = await buildSamlApp(key, {
      session: { csrf: { exclude: [ACS_PATH] } },
      plugins: [HttpSecurityPlugin({ csrf: {} })],
    });
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar);
    const response = await crossSitePost(jar, signedResponse(key, requestId));
    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  it("signs in with them, on a NEW session that holds none of the old one's data", async () => {
    harness = await buildSamlApp(key, composed(true));
    const jar = new MultiCookieJar();
    // Same-origin POSTs to the app's own routes need the app's own origin.
    const { token } = await (await jar.fetch(harness.app, '/_csrf')).json() as { token: string };
    const remember = await jar.fetch(harness.app, '/_remember', {
      method: 'POST',
      headers: { origin: 'http://localhost', 'x-csrf-token': token },
    });
    expect(remember.status).toBe(200);
    await remember.body?.cancel();
    // Control: the data really is in the pre-SAML session.
    const before = await jar.fetch(harness.app, '/_remembered');
    expect(await before.json()).toEqual({ value: 'before-saml' });
    const requestId = await startLogin(harness, jar, '?returnTo=/dashboard');

    const response = await crossSitePost(jar, signedResponse(key, requestId));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard');

    const me = await jar.fetch(harness.app, '/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe('corp:alice');
    const remembered = await jar.fetch(harness.app, '/_remembered');
    expect(await remembered.json()).toEqual({ value: null });
  });
});
