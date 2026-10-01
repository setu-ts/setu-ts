import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IKernelApplication } from '@setu-ts/kernel';

import { buildPasskeyApp, CookieJar, ORIGIN } from '../fixtures/passkey-app.ts';
import {
  fromBase64Url,
  toBase64Url,
  VirtualAuthenticator,
} from '../fixtures/virtual-authenticator.ts';

/** The four ceremony routes. */
const REGISTER_OPTIONS = '/auth/passkeys/register/options';
const REGISTER_VERIFY = '/auth/passkeys/register/verify';
const LOGIN_OPTIONS = '/auth/passkeys/login/options';
const LOGIN_VERIFY = '/auth/passkeys/login/verify';

/** Registers a passkey on the app for `jar` and returns the authenticator. */
async function registerPasskey(
  app: IKernelApplication,
  jar: CookieJar,
): Promise<VirtualAuthenticator> {
  const options = await (await jar.postJson(app, REGISTER_OPTIONS, {})).json();
  const authenticator = await VirtualAuthenticator.create('ES256');
  const body = await authenticator.registrationResult({
    challenge: options.challenge,
    rpId: options.rp.id,
    origin: ORIGIN,
  });
  const response = await jar.postJson(app, REGISTER_VERIFY, body);
  expect(response.status).toBe(200);
  // The authenticator now holds the handle the server issued, the way a real
  // one learns it during registration.
  authenticator.userHandle = fromBase64Url(options.user.id);
  return authenticator;
}

describe('passkey routes', () => {
  it('registers a passkey for a signed-in principal', async () => {
    const { app } = await buildPasskeyApp();
    const jar = new CookieJar();
    await jar.postJson(app, '/password-login', {});
    const optionsResponse = await jar.postJson(app, REGISTER_OPTIONS, {});
    expect(optionsResponse.status).toBe(200);
    const options = await optionsResponse.json();
    expect(options.rp.id).toBe('localhost');
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection.residentKey).toBe('required');
    expect(options.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual([-8, -7, -257]);
    expect(options.user.id).toHaveLength(43); // 32 random bytes, base64url

    const authenticator = await VirtualAuthenticator.create('ES256');
    const body = await authenticator.registrationResult({
      challenge: options.challenge,
      rpId: options.rp.id,
      origin: ORIGIN,
    });
    const verifyResponse = await jar.postJson(app, REGISTER_VERIFY, body);
    expect(verifyResponse.status).toBe(200);
    const verified = await verifyResponse.json();
    expect(verified.status).toBe('registered');
    expect(verified.credentialId).toBe(toBase64Url(authenticator.credentialId));
  });

  it('refuses register/options for an anonymous caller', async () => {
    const { app } = await buildPasskeyApp();
    const jar = new CookieJar();
    const response = await jar.postJson(app, REGISTER_OPTIONS, {});
    expect(response.status).toBe(401);
  });

  it('signs out, then signs in username-less and reaches a guarded route', async () => {
    const { app } = await buildPasskeyApp();
    const jar = new CookieJar();
    await jar.postJson(app, '/password-login', {});
    const authenticator = await registerPasskey(app, jar);
    expect((await jar.fetch(app, '/me')).status).toBe(200);

    // Sign out: the guarded route closes.
    expect((await jar.postJson(app, '/auth/logout', {})).status).toBe(302);
    expect((await jar.fetch(app, '/me')).status).toBe(401);

    // Username-less sign-in with the registered credential.
    const loginOptions = await (await jar.postJson(app, LOGIN_OPTIONS, {})).json();
    expect(loginOptions.allowCredentials).toEqual([]);
    const assertion = await authenticator.assertionResult({
      challenge: loginOptions.challenge,
      rpId: loginOptions.rpId,
      origin: ORIGIN,
    });
    const loginResponse = await jar.postJson(app, LOGIN_VERIFY, assertion);
    expect(loginResponse.status).toBe(200);
    expect((await loginResponse.json()).status).toBe('signed-in');
    const me = await jar.fetch(app, '/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe('alice');
  });

  it('refuses a replayed assertion with the store claim, not the session alone', async () => {
    const { app } = await buildPasskeyApp();
    const jar = new CookieJar();
    await jar.postJson(app, '/password-login', {});
    const authenticator = await registerPasskey(app, jar);
    await jar.postJson(app, '/auth/logout', {});

    const loginOptions = await (await jar.postJson(app, LOGIN_OPTIONS, {})).json();
    // The cookie login/options set still carries the challenge; the verify
    // response replaces it with one that does not.
    const preVerifyCookie = jar.cookie;
    const assertion = await authenticator.assertionResult({
      challenge: loginOptions.challenge,
      rpId: loginOptions.rpId,
      origin: ORIGIN,
    });
    expect((await jar.postJson(app, LOGIN_VERIFY, assertion)).status).toBe(200);
    // The OLDER cookie — the one the login/options response set, still
    // carrying the consumed challenge — is what the store claim exists for:
    // on the encrypted-cookie strategy removing the challenge only changes
    // the cookie sent back. Replay the assertion with it.
    const currentCookie = jar.cookie;
    jar.cookie = preVerifyCookie;
    const replay = await jar.postJson(app, LOGIN_VERIFY, assertion);
    jar.cookie = currentCookie;
    expect(replay.status).toBe(400);
    expect((await replay.json()).detail).toBe('challenge-used');
  });

  it('answers 409 when a credential id is registered twice', async () => {
    const { app } = await buildPasskeyApp();
    const jar = new CookieJar();
    await jar.postJson(app, '/password-login', {});
    const options = await (await jar.postJson(app, REGISTER_OPTIONS, {})).json();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const body = await authenticator.registrationResult({
      challenge: options.challenge,
      rpId: options.rp.id,
      origin: ORIGIN,
    });
    expect((await jar.postJson(app, REGISTER_VERIFY, body)).status).toBe(200);
    // The same credential id again: refused with the duplicate's own status,
    // which exercises the 409 branch the unit tests cannot reach by route.
    const secondOptions = await (await jar.postJson(app, REGISTER_OPTIONS, {})).json();
    const secondBody = await authenticator.registrationResult({
      challenge: secondOptions.challenge,
      rpId: secondOptions.rp.id,
      origin: ORIGIN,
    });
    const duplicate = await jar.postJson(app, REGISTER_VERIFY, secondBody);
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).detail).toBe('credential-duplicate');
  });

  it('answers 400 with the malformed detail for an unparseable body', async () => {
    const { app } = await buildPasskeyApp();
    const jar = new CookieJar();
    await jar.postJson(app, '/password-login', {});
    const response = await jar.fetch(app, LOGIN_VERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toBe('malformed');
  });

  it('answers 403 without the CSRF header token and succeeds with it', async () => {
    const { app } = await buildPasskeyApp({
      session: { csrf: { headerName: 'x-csrf-token' } },
    });
    const jar = new CookieJar();
    await jar.postJson(app, '/password-login', {});
    // The CSRF token route mints through the session plugin's own path.
    const token = ((await (await jar.fetch(app, '/_csrf')).json()) as { token: string }).token;
    // Without the header token, the ceremony POST is refused by the CSRF check.
    const refused = await jar.postJson(app, LOGIN_OPTIONS, {});
    expect(refused.status).toBe(403);
    const accepted = await jar.postJson(app, LOGIN_OPTIONS, {}, {
      'x-csrf-token': token,
    });
    expect(accepted.status).toBe(200);
  });
});
