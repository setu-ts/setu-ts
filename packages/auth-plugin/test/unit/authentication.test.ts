import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  createCeremoniesHarness,
  ORIGIN,
  registrationOptionsOf,
} from '../fixtures/passkey-ceremonies.ts';
import type { CeremoniesHarness } from '../fixtures/passkey-ceremonies.ts';
import { fromBase64Url, VirtualAuthenticator } from '../fixtures/virtual-authenticator.ts';
import { encodeBase64Url } from '../../src/utils/base64url.ts';

/** Registers one credential on the harness and returns the authenticator. */
async function enrol(harness: CeremoniesHarness): Promise<VirtualAuthenticator> {
  const authenticator = await VirtualAuthenticator.create('ES256');
  const optionsJson = await registrationOptionsOf(harness);
  const body = await authenticator.registrationResult({ challenge: optionsJson!.challenge });
  const outcome = await harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
  if (!outcome.ok) {
    throw new Error(`enrolment failed: ${JSON.stringify(outcome)}`);
  }
  // The authenticator now holds the handle the server issued, the way a real
  // one learns it during registration.
  authenticator.userHandle = fromBase64Url(optionsJson!.user.id);
  return authenticator;
}

/** The tamper knobs the authentication tests pass to the authenticator. */
interface AuthenticateOptions {
  readonly challengeOverride?: string;
  readonly type?: string;
  readonly uv?: boolean;
  readonly up?: boolean;
  readonly crossOrigin?: boolean;
  readonly counter?: number;
  readonly omitUserHandle?: boolean;
  readonly userHandle?: Uint8Array;
  readonly signOver?: Uint8Array;
  readonly signatureOverride?: Uint8Array;
  readonly rpId?: string;
  readonly origin?: string;
}

/** Runs one authentication ceremony against `harness`. */
async function authenticate(
  harness: CeremoniesHarness,
  authenticator: VirtualAuthenticator,
  options: AuthenticateOptions = {},
) {
  const optionsJson = await harness.ceremonies.authenticationOptions(harness.ctx);
  const { challengeOverride, ...rest } = options;
  const challenge = challengeOverride ?? optionsJson.challenge;
  const body = await authenticator.assertionResult({ ...rest, challenge });
  return harness.ceremonies.verifyAuthentication(harness.ctx, body);
}

describe('authentication ceremony', () => {
  it('signs the user in username-less and records the pop method', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const outcome = await authenticate(harness, authenticator, { counter: 0 });
    expect(outcome).toEqual({ ok: true, status: 'signed-in' });
    expect(harness.authSession.recordedSignIns).toEqual([
      { principal: { id: 'alice', roles: ['user'] }, methods: ['pop'] },
    ]);
  });

  it('records pop whatever the backed-up flag says', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const optionsJson = await harness.ceremonies.authenticationOptions(harness.ctx);
    const body = await authenticator.assertionResult({ challenge: optionsJson.challenge });
    await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    // The enrolment stored backedUp true; the recorded method is still pop.
    expect(harness.authSession.recordedSignIns[0]?.methods).toEqual(['pop']);
  });

  it('accepts a both-zero counter (a synced passkey)', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const outcome = await authenticate(harness, authenticator, { counter: 0 });
    expect(outcome).toEqual({ ok: true, status: 'signed-in' });
  });

  it('accepts an advancing counter and stores it', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const first = await authenticate(harness, authenticator, { counter: 5 });
    expect(first).toEqual({ ok: true, status: 'signed-in' });
    const stored = await harness.store.findById(encodeBase64Url(authenticator.credentialId));
    expect(stored?.counter).toBe(5);
  });

  it('refuses a counter that goes backwards', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    await authenticate(harness, authenticator, { counter: 7 });
    // A counter below the stored one is refused and reported as a possible
    // cloned authenticator.
    const outcome = await authenticate(harness, authenticator, { counter: 6 });
    expect(outcome).toEqual({ ok: false, reason: 'counter-refused' });
  });

  it('refuses a UV-less assertion for username-less sign-in', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const outcome = await authenticate(harness, authenticator, { uv: false });
    expect(outcome).toEqual({ ok: false, reason: 'flags-refused' });
  });

  it('refuses a wrong ceremony type', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const outcome = await authenticate(harness, authenticator, { type: 'webauthn.create' });
    expect(outcome).toEqual({ ok: false, reason: 'ceremony-type' });
  });

  it('refuses a wrong challenge', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const outcome = await authenticate(harness, authenticator, { challengeOverride: 'AAAA' });
    expect(outcome).toEqual({ ok: false, reason: 'challenge-missing' });
  });

  it('refuses a foreign origin', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const outcome = await authenticate(harness, authenticator, { origin: 'https://evil.test' });
    expect(outcome).toEqual({ ok: false, reason: 'origin-refused' });
  });

  it('refuses a cross-origin ceremony', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const outcome = await authenticate(harness, authenticator, { crossOrigin: true });
    expect(outcome).toEqual({ ok: false, reason: 'cross-origin' });
  });

  it('refuses a wrong RP ID hash', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const outcome = await authenticate(harness, authenticator, {
      rpId: 'evil.test',
      origin: ORIGIN,
    });
    expect(outcome).toEqual({ ok: false, reason: 'rp-id-mismatch' });
  });

  it('refuses a credential the store does not know', async () => {
    const harness = createCeremoniesHarness();
    const rogue = await VirtualAuthenticator.create('ES256');
    const optionsJson = await harness.ceremonies.authenticationOptions(harness.ctx);
    const body = await rogue.assertionResult({ challenge: optionsJson.challenge });
    const outcome = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(outcome).toEqual({ ok: false, reason: 'credential-unknown' });
  });

  it('refuses a mismatched user handle', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const optionsJson = await harness.ceremonies.authenticationOptions(harness.ctx);
    const wrongHandle = new Uint8Array(32);
    wrongHandle[0] = 9;
    const body = await authenticator.assertionResult({
      challenge: optionsJson.challenge,
      userHandle: wrongHandle,
    });
    const outcome = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(outcome).toEqual({ ok: false, reason: 'user-handle-mismatch' });
  });

  it('refuses a forged signature', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const optionsJson = await harness.ceremonies.authenticationOptions(harness.ctx);
    const rogue = await VirtualAuthenticator.create('ES256');
    const body = await authenticator.assertionResult({
      challenge: optionsJson.challenge,
      signatureOverride: await rogue.sign(new Uint8Array(69)),
    });
    const outcome = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(outcome).toEqual({ ok: false, reason: 'signature-invalid' });
  });

  it('refuses a signature over tampered authenticator data', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await enrol(harness);
    const optionsJson = await harness.ceremonies.authenticationOptions(harness.ctx);
    // The signature is valid but computed over different authenticator data
    // than the response carries (a counter manipulation).
    const body = await authenticator.assertionResult({
      challenge: optionsJson.challenge,
      signOver: new Uint8Array(69),
    });
    const outcome = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(outcome).toEqual({ ok: false, reason: 'signature-invalid' });
  });
});
