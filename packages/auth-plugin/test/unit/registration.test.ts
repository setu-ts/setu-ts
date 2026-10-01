import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createCeremoniesHarness, ORIGIN } from '../fixtures/passkey-ceremonies.ts';
import type { CeremoniesHarness } from '../fixtures/passkey-ceremonies.ts';
import { VirtualAuthenticator } from '../fixtures/virtual-authenticator.ts';
import { encodeBase64Url } from '../../src/utils/base64url.ts';

/** The tamper knobs the registration tests pass to the authenticator. */
interface RegisterOptions {
  readonly challengeOverride?: string;
  readonly type?: string;
  readonly fmt?: string;
  readonly uv?: boolean;
  readonly up?: boolean;
  readonly backedUp?: boolean;
  readonly crossOrigin?: boolean;
  readonly counter?: number;
  readonly omitCredentialData?: boolean;
  readonly coseKeyOverride?: Uint8Array;
  readonly transports?: readonly string[];
  readonly rpId?: string;
  readonly origin?: string;
}

/** Runs one registration ceremony against `harness` for `authenticator`. */
async function register(
  harness: CeremoniesHarness,
  authenticator: VirtualAuthenticator,
  options: RegisterOptions = {},
) {
  const optionsJson = await harness.ceremonies.registrationOptions(harness.ctx);
  if (optionsJson === null) {
    throw new Error('no signed-in principal in the harness');
  }
  const { challengeOverride, ...rest } = options;
  const challenge = challengeOverride ?? optionsJson.challenge;
  const body = await authenticator.registrationResult({ ...rest, challenge });
  return harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
}

describe('registration ceremony', () => {
  it('accepts a valid ES256 registration and stores the credential', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const outcome = await register(harness, authenticator);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.credentialId).toBe(encodeBase64Url(authenticator.credentialId));
    }
  });

  it('records the credential as unverified with its flags and transports', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const optionsJson = await harness.ceremonies.registrationOptions(harness.ctx);
    const body = await authenticator.registrationResult({
      challenge: optionsJson!.challenge,
      backedUp: true,
      transports: ['hybrid', 'internal'],
    });
    const outcome = await harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
    expect(outcome.ok).toBe(true);
    const stored = await harness.store.findById(encodeBase64Url(authenticator.credentialId));
    expect(stored).not.toBeNull();
    expect(stored?.attestation).toBe('unverified');
    expect(stored?.backedUp).toBe(true);
    expect(stored?.transports).toEqual(['hybrid', 'internal']);
    expect(stored?.principalId).toBe('alice');
    expect(stored?.algorithm).toBe(-7);
    expect(stored?.userHandle).toBe(optionsJson!.user.id);
  });

  it('accepts RS256 and EdDSA credentials', async () => {
    for (const algorithm of ['RS256', 'EdDSA'] as const) {
      const harness = createCeremoniesHarness();
      const authenticator = await VirtualAuthenticator.create(algorithm);
      const outcome = await register(harness, authenticator);
      expect(outcome.ok).toBe(true);
    }
  });

  it('accepts a packed self-attestation and never reads its statement', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const outcome = await register(harness, authenticator, { fmt: 'packed' });
    expect(outcome.ok).toBe(true);
  });

  it('accepts a registration when userVerification is preferred and UV is unset', async () => {
    const harness = createCeremoniesHarness({
      passkeys: { userVerification: 'preferred' },
    });
    const authenticator = await VirtualAuthenticator.create('ES256');
    const optionsJson = await harness.ceremonies.registrationOptions(harness.ctx);
    const body = await authenticator.registrationResult({
      challenge: optionsJson!.challenge,
      uv: false,
    });
    const outcome = await harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
    expect(outcome.ok).toBe(true);
  });

  it('refuses a wrong ceremony type', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const outcome = await register(harness, authenticator, { type: 'webauthn.get' });
    expect(outcome).toEqual({ ok: false, reason: 'ceremony-type' });
  });

  it('refuses a wrong challenge', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const outcome = await register(harness, authenticator, { challengeOverride: 'AAAA' });
    expect(outcome).toEqual({ ok: false, reason: 'challenge-missing' });
  });

  it('refuses a foreign origin', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const outcome = await register(harness, authenticator, { origin: 'https://evil.test' });
    expect(outcome).toEqual({ ok: false, reason: 'origin-refused' });
  });

  it('refuses a cross-origin ceremony', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const outcome = await register(harness, authenticator, { crossOrigin: true });
    expect(outcome).toEqual({ ok: false, reason: 'cross-origin' });
  });

  it('refuses a wrong RP ID hash', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    // Built against a different RP ID, so the hash disagrees.
    const outcome = await register(harness, authenticator, {
      rpId: 'evil.test',
      origin: ORIGIN,
    });
    expect(outcome).toEqual({ ok: false, reason: 'rp-id-mismatch' });
  });

  it('refuses a user-present flag that is unset', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const outcome = await register(harness, authenticator, { up: false });
    expect(outcome).toEqual({ ok: false, reason: 'flags-refused' });
  });

  it('refuses a user-verified flag that is unset when UV is required', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const outcome = await register(harness, authenticator, { uv: false });
    expect(outcome).toEqual({ ok: false, reason: 'flags-refused' });
  });

  it('refuses a credential id that is already stored', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const first = await register(harness, authenticator);
    expect(first.ok).toBe(true);
    const second = await register(harness, authenticator);
    expect(second).toEqual({ ok: false, reason: 'credential-duplicate' });
  });

  it('refuses a response with no attested credential data', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const outcome = await register(harness, authenticator, { omitCredentialData: true });
    expect(outcome).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses an unsupported algorithm', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    // A COSE key labelled ES384 (-47), which this verifier does not accept.
    const { encodeMap, encodeUint, encodeNegative, encodeByteString } = await import(
      '../fixtures/virtual-authenticator.ts'
    );
    const es384Key = encodeMap([
      [encodeUint(1), encodeUint(2)],
      [encodeUint(3), encodeNegative(-47)],
      [encodeNegative(-1), encodeUint(1)],
      [encodeNegative(-2), encodeByteString(new Uint8Array(32))],
      [encodeNegative(-3), encodeByteString(new Uint8Array(32))],
    ]);
    const outcome = await register(harness, authenticator, { coseKeyOverride: es384Key });
    expect(outcome).toEqual({ ok: false, reason: 'algorithm-refused' });
  });

  it('refuses a malformed attestation object', async () => {
    const harness = createCeremoniesHarness();
    const optionsJson = await harness.ceremonies.registrationOptions(harness.ctx);
    const { buildClientData } = await import('../fixtures/virtual-authenticator.ts');
    const outcome = await harness.ceremonies.verifyRegistration(
      harness.ctx,
      {
        response: {
          clientDataJSON: buildClientData({
            type: 'webauthn.create',
            challenge: optionsJson!.challenge,
            origin: 'http://localhost',
          }),
          attestationObject: '!!!',
        },
      },
      { id: 'alice' },
    );
    expect(outcome).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a body with no response object', async () => {
    const harness = createCeremoniesHarness();
    await harness.ceremonies.registrationOptions(harness.ctx);
    const outcome = await harness.ceremonies.verifyRegistration(harness.ctx, {}, { id: 'alice' });
    expect(outcome).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a second registration with a consumed challenge', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const optionsJson = await harness.ceremonies.registrationOptions(harness.ctx);
    const body = await authenticator.registrationResult({ challenge: optionsJson!.challenge });
    const first = await harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
    expect(first.ok).toBe(true);
    // The session challenge is gone; the same body replayed is refused.
    const replay = await harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
    expect(replay).toEqual({ ok: false, reason: 'challenge-missing' });
  });
});
