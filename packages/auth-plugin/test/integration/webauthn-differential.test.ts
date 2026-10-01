import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createCeremoniesHarness, ORIGIN, RP_ID } from '../fixtures/passkey-ceremonies.ts';
import { fromBase64Url, VirtualAuthenticator } from '../fixtures/virtual-authenticator.ts';

/**
 * The differential test against the reference implementation (plan §6).
 *
 * `@simplewebauthn/server` appears ONLY here, as a test oracle: every
 * virtual-authenticator response below is offered to BOTH this plugin's
 * verifier and the library's, and the two must accept or refuse it
 * identically. The library is guarded — a machine without the package skips
 * rather than fails — but the load path is a real `import()`, so the suite
 * exercises the real oracle wherever the package is installed.
 */

type Oracle = typeof import('npm:@simplewebauthn/server@14.0.3');

let oracle: Oracle | null = null;
try {
  oracle = await import('npm:@simplewebauthn/server@14.0.3');
} catch {
  // The oracle is unavailable; the differential steps skip below.
}

/** Whether `body` verifies against the oracle. */
async function oracleRegistration(body: unknown, challenge: string): Promise<boolean> {
  if (oracle === null) {
    return true; // Skipped steps never disagree.
  }
  try {
    const verification = await oracle.verifyRegistrationResponse({
      response: body as Parameters<Oracle['verifyRegistrationResponse']>[0]['response'],
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    return verification.verified;
  } catch {
    return false;
  }
}

/** Whether `body` verifies against the oracle for an authentication. */
async function oracleAuthentication(
  body: unknown,
  challenge: string,
  credential: { id: string; publicKey: Uint8Array; counter: number },
): Promise<boolean> {
  if (oracle === null) {
    return true;
  }
  try {
    const verification = await oracle.verifyAuthenticationResponse({
      response: body as Parameters<Oracle['verifyAuthenticationResponse']>[0]['response'],
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: credential.id,
        // The oracle's `WebAuthnCredential.publicKey` is an ArrayBuffer-backed
        // `Uint8Array`; the copy is byte-identical and satisfies its type.
        publicKey: new Uint8Array(
          credential.publicKey.buffer as ArrayBuffer,
          credential.publicKey.byteOffset,
          credential.publicKey.byteLength,
        ),
        counter: credential.counter,
      },
    });
    return verification.verified;
  } catch {
    return false;
  }
}

describe('webauthn differential', () => {
  it(
    'agrees with the reference implementation on a valid registration',
    { ignore: oracle === null },
    async () => {
      const harness = createCeremoniesHarness();
      const authenticator = await VirtualAuthenticator.create('ES256');
      const options = await harness.ceremonies.registrationOptions(harness.ctx);
      const body = await authenticator.registrationResult({
        challenge: options!.challenge,
        rpId: RP_ID,
        origin: ORIGIN,
      });
      const ours = await harness.ceremonies.verifyRegistration(harness.ctx, body, {
        id: 'alice',
      });
      const theirs = await oracleRegistration(body, options!.challenge);
      expect(ours.ok).toBe(true);
      expect(theirs).toBe(true);
    },
  );

  it(
    'agrees with the reference implementation on a foreign origin',
    { ignore: oracle === null },
    async () => {
      const harness = createCeremoniesHarness();
      const authenticator = await VirtualAuthenticator.create('ES256');
      const options = await harness.ceremonies.registrationOptions(harness.ctx);
      const body = await authenticator.registrationResult({
        challenge: options!.challenge,
        rpId: RP_ID,
        origin: 'https://evil.test',
      });
      const ours = await harness.ceremonies.verifyRegistration(harness.ctx, body, {
        id: 'alice',
      });
      const theirs = await oracleRegistration(body, options!.challenge);
      expect(ours).toEqual({ ok: false, reason: 'origin-refused' });
      expect(theirs).toBe(false);
    },
  );

  // A cross-origin ceremony is deliberately NOT a differential row: this
  // verifier refuses `crossOrigin: true` (plan §3.2) and the reference
  // implementation does not check it, so the two disagree by design — the
  // plugin is the stricter of the two.

  it(
    'agrees with the reference implementation on a valid authentication',
    { ignore: oracle === null },
    async () => {
      const harness = createCeremoniesHarness();
      const authenticator = await VirtualAuthenticator.create('ES256');
      const registration = await harness.ceremonies.registrationOptions(harness.ctx);
      const registrationBody = await authenticator.registrationResult({
        challenge: registration!.challenge,
        rpId: RP_ID,
        origin: ORIGIN,
      });
      expect(
        (await harness.ceremonies.verifyRegistration(harness.ctx, registrationBody, {
          id: 'alice',
        })).ok,
      ).toBe(true);
      // The authenticator now holds the handle the server issued.
      authenticator.userHandle = fromBase64Url(registration!.user.id);
      const options = await harness.ceremonies.authenticationOptions(harness.ctx);
      const body = await authenticator.assertionResult({
        challenge: options.challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 1,
      });
      const ours = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
      const theirs = await oracleAuthentication(body, options.challenge, {
        id: body.id,
        publicKey: await authenticator.coseKey(),
        counter: 0,
      });
      expect(ours).toEqual({ ok: true, status: 'signed-in' });
      expect(theirs).toBe(true);
    },
  );

  it(
    'agrees with the reference implementation on a lowered counter',
    { ignore: oracle === null },
    async () => {
      const harness = createCeremoniesHarness();
      const authenticator = await VirtualAuthenticator.create('ES256');
      const registration = await harness.ceremonies.registrationOptions(harness.ctx);
      const registrationBody = await authenticator.registrationResult({
        challenge: registration!.challenge,
        rpId: RP_ID,
        origin: ORIGIN,
      });
      expect(
        (await harness.ceremonies.verifyRegistration(harness.ctx, registrationBody, {
          id: 'alice',
        })).ok,
      ).toBe(true);
      authenticator.userHandle = fromBase64Url(registration!.user.id);
      // First authentication at counter 1: accepted, stored counter 1.
      const first = await harness.ceremonies.authenticationOptions(harness.ctx);
      const firstBody = await authenticator.assertionResult({
        challenge: first.challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 1,
      });
      expect((await harness.ceremonies.verifyAuthentication(harness.ctx, firstBody)).ok).toBe(
        true,
      );
      // Second authentication still at counter 1: refused by both.
      const second = await harness.ceremonies.authenticationOptions(harness.ctx);
      const secondBody = await authenticator.assertionResult({
        challenge: second.challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 1,
      });
      const ours = await harness.ceremonies.verifyAuthentication(harness.ctx, secondBody);
      const theirs = await oracleAuthentication(secondBody, second.challenge, {
        id: secondBody.id,
        publicKey: await authenticator.coseKey(),
        counter: 1,
      });
      expect(ours).toEqual({ ok: false, reason: 'counter-refused' });
      expect(theirs).toBe(false);
    },
  );

  it(
    'agrees with the reference implementation on a foreign-origin assertion',
    { ignore: oracle === null },
    async () => {
      const harness = createCeremoniesHarness();
      const authenticator = await VirtualAuthenticator.create('ES256');
      const registration = await harness.ceremonies.registrationOptions(harness.ctx);
      const registrationBody = await authenticator.registrationResult({
        challenge: registration!.challenge,
        rpId: RP_ID,
        origin: ORIGIN,
      });
      expect(
        (await harness.ceremonies.verifyRegistration(harness.ctx, registrationBody, {
          id: 'alice',
        })).ok,
      ).toBe(true);
      authenticator.userHandle = fromBase64Url(registration!.user.id);
      const options = await harness.ceremonies.authenticationOptions(harness.ctx);
      const body = await authenticator.assertionResult({
        challenge: options.challenge,
        rpId: RP_ID,
        origin: 'https://evil.test',
      });
      const ours = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
      const theirs = await oracleAuthentication(body, options.challenge, {
        id: body.id,
        publicKey: await authenticator.coseKey(),
        counter: 0,
      });
      expect(ours).toEqual({ ok: false, reason: 'origin-refused' });
      expect(theirs).toBe(false);
    },
  );
});
