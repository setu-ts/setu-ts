import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IKernelApplication } from '@setu-ts/kernel';

import { buildPasskeyApp, CookieJar, ORIGIN } from '../fixtures/passkey-app.ts';
import {
  fromBase64Url,
  toBase64Url,
  VirtualAuthenticator,
} from '../fixtures/virtual-authenticator.ts';

const REGISTER_OPTIONS = '/auth/passkeys/register/options';
const REGISTER_VERIFY = '/auth/passkeys/register/verify';
const LOGIN_OPTIONS = '/auth/passkeys/login/options';
const LOGIN_VERIFY = '/auth/passkeys/login/verify';

/**
 * Enrols a passkey on an app WITHOUT an MFA policy (registration requires a
 * signed-in principal, which a required-MFA password login never produces).
 */
async function enrol(
  app: IKernelApplication,
  jar: CookieJar,
): Promise<{ authenticator: VirtualAuthenticator; issuedHandle: string }> {
  const options = await (await jar.postJson(app, REGISTER_OPTIONS, {})).json();
  const authenticator = await VirtualAuthenticator.create('ES256');
  const body = await authenticator.registrationResult({
    challenge: options.challenge,
    rpId: options.rp.id,
    origin: ORIGIN,
  });
  const response = await jar.postJson(app, REGISTER_VERIFY, body);
  expect(response.status).toBe(200);
  authenticator.userHandle = fromBase64Url(options.user.id);
  return { authenticator, issuedHandle: options.user.id };
}

describe('passkey as a second factor', () => {
  it('completes a pending sign-in from a password first factor', async () => {
    // Enrol the passkey while the policy is off, then share the store with an
    // app whose policy requires a second factor.
    const first = await buildPasskeyApp();
    const firstJar = new CookieJar();
    await firstJar.postJson(first.app, '/password-login', {});
    const { authenticator } = await enrol(first.app, firstJar);

    const mfaApp = await buildPasskeyApp({
      passkeys: { store: first.store },
      mfaRequired: () => true,
    });
    const mfaJar = new CookieJar();
    const passwordLogin = await mfaJar.postJson(mfaApp.app, '/password-login', {});
    expect(((await passwordLogin.json()) as { outcome: string }).outcome).toBe(
      'second-factor-required',
    );
    // The guarded route stays closed while the sign-in is pending.
    expect((await mfaJar.fetch(mfaApp.app, '/me')).status).toBe(401);

    const loginOptions = await (await mfaJar.postJson(mfaApp.app, LOGIN_OPTIONS, {})).json();
    // The pending principal's credentials are the hint.
    expect(loginOptions.allowCredentials.length).toBe(1);
    expect(loginOptions.allowCredentials[0].id).toBe(toBase64Url(authenticator.credentialId));

    const assertion = await authenticator.assertionResult({
      challenge: loginOptions.challenge,
      rpId: loginOptions.rpId,
      origin: ORIGIN,
      counter: 0,
    });
    const verifyResponse = await mfaJar.postJson(mfaApp.app, LOGIN_VERIFY, assertion);
    expect(verifyResponse.status).toBe(200);
    expect((await verifyResponse.json()).status).toBe('signed-in');
    const me = await mfaJar.fetch(mfaApp.app, '/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe('alice');
    // The recorded amr carries BOTH factors, in order.
    const record = await (await mfaJar.fetch(mfaApp.app, '/_record')).json();
    expect(record.methods).toEqual(['pwd', 'pop']);
  });

  it('refuses another user\u2019s credential even when the options omit allowCredentials', async () => {
    const first = await buildPasskeyApp();
    // Enrol BOB's credential directly into the shared store: the attacker's
    // authenticator never registered through the ceremony.
    const rogue = await VirtualAuthenticator.create('ES256');
    await first.store.save({
      id: toBase64Url(rogue.credentialId),
      principalId: 'bob',
      userHandle: toBase64Url(rogue.userHandle),
      publicKey: await rogue.publicKeyJwk(),
      algorithm: -7,
      counter: 0,
      backedUp: false,
      transports: ['internal'],
      attestation: 'unverified',
      createdAt: 0,
    });

    const mfaApp = await buildPasskeyApp({
      passkeys: { store: first.store },
      mfaRequired: () => true,
    });
    const jar = new CookieJar();
    await jar.postJson(mfaApp.app, '/password-login', {});

    const loginOptions = await (await jar.postJson(mfaApp.app, LOGIN_OPTIONS, {})).json();
    // The pending principal (alice) holds no credential, so the hint is empty.
    expect(loginOptions.allowCredentials).toEqual([]);
    // bob's authenticator answers anyway: the hint is convenience, the
    // server-side principal comparison is the check.
    const assertion = await rogue.assertionResult({
      challenge: loginOptions.challenge,
      rpId: loginOptions.rpId,
      origin: ORIGIN,
    });
    const response = await jar.postJson(mfaApp.app, LOGIN_VERIFY, assertion);
    expect(response.status).toBe(403);
    expect((await response.json()).detail).toBe('wrong-principal');
    // The session stays pending: the guarded route never opened.
    expect((await jar.fetch(mfaApp.app, '/me')).status).toBe(401);
  });

  it('accepts a UV-less assertion as the second factor', async () => {
    const first = await buildPasskeyApp();
    const firstJar = new CookieJar();
    await firstJar.postJson(first.app, '/password-login', {});
    const { authenticator } = await enrol(first.app, firstJar);

    const mfaApp = await buildPasskeyApp({
      passkeys: { store: first.store },
      mfaRequired: () => true,
    });
    const mfaJar = new CookieJar();
    await mfaJar.postJson(mfaApp.app, '/password-login', {});
    const loginOptions = await (await mfaJar.postJson(mfaApp.app, LOGIN_OPTIONS, {})).json();
    // Possession is exactly what a second factor adds, so UV is not required
    // here — unlike a username-less sign-in.
    const assertion = await authenticator.assertionResult({
      challenge: loginOptions.challenge,
      rpId: loginOptions.rpId,
      origin: ORIGIN,
      uv: false,
      counter: 0,
    });
    const response = await mfaJar.postJson(mfaApp.app, LOGIN_VERIFY, assertion);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('signed-in');
  });
});
