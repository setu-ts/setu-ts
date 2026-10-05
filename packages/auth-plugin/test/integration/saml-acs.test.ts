/**
 * The SAML assertion consumer service through a real kernel application and
 * the REAL node-saml (M100f plan §6): one valid sign-in, then every refusal
 * the design names — tampered, unsigned, wrapped, wrong key, wrong audience,
 * wrong issuer, wrong recipient, expired, unsolicited, replayed, and a response
 * from a browser that did not start the login.
 *
 * @module
 */
import { afterEach, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  assertionXml,
  buildSamlApp,
  encode,
  generateSigningKey,
  MultiCookieJar,
  postAcs,
  PROVIDER,
  responseXml,
  signedResponse,
  signElement,
  startLogin,
  validFields,
} from '../fixtures/saml-idp.ts';
import type { SamlHarness, TestSigningKey } from '../fixtures/saml-idp.ts';
import { SAML_BINDING_COOKIE } from '../../src/saml/binding-cookie.ts';

let key: TestSigningKey;
let attacker: TestSigningKey;
let harness: SamlHarness | undefined;

beforeAll(async () => {
  key = await generateSigningKey();
  attacker = await generateSigningKey();
});

afterEach(async () => {
  await harness?.app.stop();
  harness = undefined;
});

async function signedInUser(jar: MultiCookieJar): Promise<unknown> {
  const me = await jar.fetch(harness!.app, '/me');
  return me.status === 200 ? ((await me.json()) as { user: unknown }).user : null;
}

/** Asserts a 401 with the fixed detail and that no library text leaks. */
async function expectRefused(response: Response, detail: string): Promise<void> {
  expect(response.status).toBe(401);
  const body = await response.text();
  expect(body).toContain(detail);
  expect(body.toLowerCase()).not.toContain('signature');
  expect(body.toLowerCase()).not.toContain('audience');
}

describe('SAML ACS (real node-saml)', () => {
  it('signs in with a valid signed assertion and redirects to returnTo', async () => {
    harness = await buildSamlApp(key);
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar, '?returnTo=/dashboard');
    expect(jar.cookies.has(SAML_BINDING_COOKIE)).toBe(true);

    const response = await postAcs(harness, jar, signedResponse(key, requestId));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard');
    // The binding cookie is single use.
    expect(jar.cookies.has(SAML_BINDING_COOKIE)).toBe(false);
    expect(await signedInUser(jar)).toMatchObject({
      id: 'corp:alice',
      claims: { email: 'alice@corp.test', amr: ['fed'] },
    });
  });

  it('passes a frozen profile with NameID, format, session index and attributes', async () => {
    let seen: unknown;
    harness = await buildSamlApp(key, {
      provider: {
        toPrincipal: (profile) => {
          seen = profile;
          return { id: profile.nameID, roles: [] };
        },
      },
    });
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar);
    await postAcs(
      harness,
      jar,
      signedResponse(key, requestId, { attributes: { email: 'a@x', groups: ['g1', 'g2'] } }),
    );
    expect(seen).toEqual({
      issuer: 'https://idp.test/saml',
      nameID: 'alice',
      nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
      sessionIndex: 'session-1',
      attributes: { email: 'a@x', groups: ['g1', 'g2'] },
    });
    expect(Object.isFrozen(seen)).toBe(true);
  });

  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly build: (requestId: string) => string;
  }> = [
    {
      name: 'a tampered NameID',
      build: (id) => {
        const fields = validFields(id);
        const signed = signElement(assertionXml(fields), fields.id, key);
        return encode(responseXml(signed.replace('>alice<', '>admin<'), id));
      },
    },
    {
      name: 'an unsigned assertion',
      build: (id) => encode(responseXml(assertionXml(validFields(id)), id)),
    },
    {
      name: 'an assertion signed by an untrusted key',
      build: (id) => signedResponse(attacker, id),
    },
    {
      name: 'an unsigned assertion wrapped BEFORE a signed one',
      build: (id) => {
        const good = validFields(id);
        const evil = validFields(id, { nameID: 'admin' });
        return encode(
          responseXml(assertionXml(evil) + signElement(assertionXml(good), good.id, key), id),
        );
      },
    },
    {
      name: 'an unsigned assertion wrapped AFTER a signed one',
      build: (id) => {
        const good = validFields(id);
        const evil = validFields(id, { nameID: 'admin' });
        return encode(
          responseXml(signElement(assertionXml(good), good.id, key) + assertionXml(evil), id),
        );
      },
    },
    {
      name: 'a wrong audience',
      build: (id) => signedResponse(key, id, { audience: 'https://other-sp.test' }),
    },
    {
      name: 'a wrong issuer',
      build: (id) => signedResponse(key, id, { issuer: 'https://evil-idp.test' }),
    },
    {
      name: 'a wrong recipient',
      build: (id) => signedResponse(key, id, { recipient: 'https://other-sp.test/acs' }),
    },
    {
      name: 'a missing recipient',
      build: (id) => signedResponse(key, id, { recipient: null }),
    },
    {
      name: 'an expired assertion',
      build: (id) =>
        signedResponse(key, id, {
          notBefore: Date.now() - 3_600_000,
          notOnOrAfter: Date.now() - 1_800_000,
        }),
    },
    {
      name: 'a response with no InResponseTo (IdP-initiated)',
      build: (id) => {
        const fields = validFields(id);
        return encode(responseXml(signElement(assertionXml(fields), fields.id, key), null));
      },
    },
    {
      // The response envelope is unsigned when only the assertion is: its
      // InResponseTo alone cannot bind a signed assertion to this login.
      name: 'a signed assertion with no InResponseTo of its own, wrapped in a fresh response',
      build: (id) => signedResponse(key, id, { inResponseTo: null }),
    },
    {
      name: 'a signed assertion bound to a different request',
      build: (id) => {
        const fields = validFields(id, { inResponseTo: '_some-other-request' });
        return encode(responseXml(signElement(assertionXml(fields), fields.id, key), id));
      },
    },
    {
      // node-saml copies every attribute onto its profile, so without reading
      // the element an attribute named `nameID` would choose the principal.
      name: 'an assertion with no NameID element but a nameID attribute',
      build: (id) =>
        signedResponse(key, id, {
          nameID: null,
          attributes: { nameID: 'from-attribute', issuer: 'https://idp.test/saml' },
        }),
    },
    {
      name: 'a response answering a request this server never issued',
      build: () => signedResponse(key, '_never-issued'),
    },
  ];

  for (const refusal of refusals) {
    it(`refuses ${refusal.name}`, async () => {
      harness = await buildSamlApp(key);
      const jar = new MultiCookieJar();
      const requestId = await startLogin(harness, jar);
      const response = await postAcs(harness, jar, refusal.build(requestId));
      await expectRefused(
        response,
        refusal.name.includes('never issued') ? 'assertion-invalid' : '',
      );
      expect(await signedInUser(jar)).toBeNull();
    });
  }

  it('refuses a replay of a captured valid response', async () => {
    harness = await buildSamlApp(key);
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar);
    const captured = signedResponse(key, requestId);
    const binding = jar.cookies.get(SAML_BINDING_COOKIE)!;
    expect((await postAcs(harness, jar, captured)).status).toBe(302);
    // The attacker replays it, cookie and all, from a fresh browser.
    const replay = new MultiCookieJar();
    replay.cookies.set(SAML_BINDING_COOKIE, binding);
    // node-saml finds no pending request for it and refuses before the binding
    // check runs, so the code is assertion-invalid rather than state-invalid.
    await expectRefused(await postAcs(harness, replay, captured), 'assertion-invalid');
  });

  it('refuses a second, fresh response carrying an already-used assertion id', async () => {
    harness = await buildSamlApp(key);
    const jar = new MultiCookieJar();
    const first = await startLogin(harness, jar);
    const reused = '_assert-reused';
    expect((await postAcs(harness, jar, signedResponse(key, first, { id: reused }))).status).toBe(
      302,
    );
    const second = await startLogin(harness, jar);
    await expectRefused(
      await postAcs(harness, jar, signedResponse(key, second, { id: reused })),
      'assertion-invalid',
    );
  });

  it('refuses a valid response posted by a browser without the binding cookie', async () => {
    harness = await buildSamlApp(key);
    const victim = new MultiCookieJar();
    const attackerJar = new MultiCookieJar();
    // The attacker starts a login and obtains a valid response for THEIR account…
    const requestId = await startLogin(harness, attackerJar);
    const response = signedResponse(key, requestId, { nameID: 'mallory' });
    // …and makes the victim's browser post it.
    await expectRefused(await postAcs(harness, victim, response), 'state-invalid');
    expect(await signedInUser(victim)).toBeNull();
    // V8-25 (M101c): the victim's post did NOT consume the request — the
    // binding is refused before consumption. The attacker, who holds the
    // binding cookie, can still sign in with the same response. (Before the
    // fix this answered `assertion-invalid`, because the library's
    // failure-path `removeAsync` had consumed the record.)
    const originPost = await postAcs(harness, attackerJar, response);
    expect(originPost.status).toBe(302);
    expect(await signedInUser(attackerJar)).toMatchObject({ id: 'corp:mallory' });
  });

  it("a foreign browser's post leaves the originator's request intact for a second login", async () => {
    harness = await buildSamlApp(key);
    const originator = new MultiCookieJar();
    const foreign = new MultiCookieJar();
    const requestId = await startLogin(harness, originator);
    const response = signedResponse(key, requestId);
    // A foreign browser (no binding cookie) posts the response first.
    await expectRefused(await postAcs(harness, foreign, response), 'state-invalid');
    // The originator, who holds the binding cookie, signs in with the same
    // response — the foreign post did not burn it.
    expect((await postAcs(harness, originator, response)).status).toBe(302);
    expect(await signedInUser(originator)).toMatchObject({ id: 'corp:alice' });
  });

  it("a cross-site junk POST carrying the victim's cookie does not burn the victim's login", async () => {
    // The ACS is CSRF-exempt and the binding cookie is `SameSite=None`, so a
    // cross-site page can make the victim's browser POST garbage here WITH
    // the cookie. That must not clear the binding: the cookie is cleared only
    // when a pending request is actually consumed (M101c security audit F2).
    harness = await buildSamlApp(key);
    const victim = new MultiCookieJar();
    const requestId = await startLogin(harness, victim);
    for (const junk of ['', encode('<not-saml/>')]) {
      const refused = await postAcs(harness, victim, junk);
      expect(refused.status).toBe(401);
      await refused.body?.cancel();
      expect(victim.cookies.has(SAML_BINDING_COOKIE)).toBe(true);
    }
    // Positive control: the victim's real IdP post still signs in, and the
    // binding is then cleared (single use).
    expect((await postAcs(harness, victim, signedResponse(key, requestId))).status).toBe(302);
    expect(victim.cookies.has(SAML_BINDING_COOKIE)).toBe(false);
    expect(await signedInUser(victim)).toMatchObject({ id: 'corp:alice' });
  });

  it("refuses a response whose InResponseTo names another browser's login", async () => {
    harness = await buildSamlApp(key);
    const alice = new MultiCookieJar();
    const bob = new MultiCookieJar();
    const aliceRequest = await startLogin(harness, alice);
    await startLogin(harness, bob);
    await expectRefused(
      await postAcs(harness, bob, signedResponse(key, aliceRequest)),
      'state-invalid',
    );
  });

  it('lets exactly one of two concurrent posts of one response sign in', async () => {
    harness = await buildSamlApp(key);
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar);
    const binding = jar.cookies.get(SAML_BINDING_COOKIE)!;
    const response = signedResponse(key, requestId);
    const a = new MultiCookieJar();
    const b = new MultiCookieJar();
    a.cookies.set(SAML_BINDING_COOKIE, binding);
    b.cookies.set(SAML_BINDING_COOKIE, binding);
    const results = await Promise.all([
      postAcs(harness, a, response),
      postAcs(harness, b, response),
    ]);
    const statuses = results.map((r) => r.status).sort();
    for (const r of results) {
      await r.body?.cancel();
    }
    expect(statuses).toEqual([302, 401]);
  });

  it('refuses a POST with no SAMLResponse field', async () => {
    harness = await buildSamlApp(key);
    const jar = new MultiCookieJar();
    await startLogin(harness, jar);
    const response = await jar.fetch(harness.app, `/auth/${PROVIDER}/acs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'RelayState=x',
    });
    await expectRefused(response, 'assertion-invalid');
  });

  it('redirects a failure to failureRedirect with a fixed code', async () => {
    harness = await buildSamlApp(key, { provider: { failureRedirect: '/login?from=saml' } });
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar);
    const response = await postAcs(harness, jar, signedResponse(attacker, requestId));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?from=saml&error=assertion-invalid');
  });

  it('answers 403 when toPrincipal refuses or throws', async () => {
    for (
      const toPrincipal of [() => null, () => {
        throw new Error('quoting a claim');
      }]
    ) {
      harness = await buildSamlApp(key, { provider: { toPrincipal } });
      const jar = new MultiCookieJar();
      const requestId = await startLogin(harness, jar);
      const response = await postAcs(harness, jar, signedResponse(key, requestId));
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain('principal-refused');
      expect(body).not.toContain('quoting');
      await harness.app.stop();
      harness = undefined;
    }
  });

  it('holds the sign-in for a second factor and redirects to the challenge path', async () => {
    harness = await buildSamlApp(key, {
      mfa: { required: () => true, challengePath: '/mfa' },
    });
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar, '?returnTo=/dashboard');
    const response = await postAcs(harness, jar, signedResponse(key, requestId));
    expect(response.headers.get('location')).toBe('/mfa');
    expect(await signedInUser(jar)).toBeNull();
  });

  it('redirects a held sign-in to returnTo when no challenge path is set', async () => {
    harness = await buildSamlApp(key, { mfa: { required: () => true } });
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar, '?returnTo=/dashboard');
    const response = await postAcs(harness, jar, signedResponse(key, requestId));
    expect(response.headers.get('location')).toBe('/dashboard');
  });
});
