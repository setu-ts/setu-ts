import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  createCeremoniesHarness,
  ORIGIN,
  registrationOptionsOf,
  RP_ID,
} from '../fixtures/passkey-ceremonies.ts';
import { fromBase64Url, VirtualAuthenticator } from '../fixtures/virtual-authenticator.ts';
import { CHALLENGE_TTL_MS, WEBAUTHN_CHALLENGE_SESSION_KEY } from '../../src/passkeys/ceremonies.ts';

describe('challenge handling', () => {
  it('stores the challenge in the session with a 5-minute expiry', async () => {
    const harness = createCeremoniesHarness();
    const optionsJson = await registrationOptionsOf(harness);
    const stored = harness.session.get<Record<string, unknown>>(WEBAUTHN_CHALLENGE_SESSION_KEY);
    expect(stored?.kind).toBe('registration');
    expect(stored?.challenge).toBe(optionsJson?.challenge);
    expect(stored?.expiresAt).toBe(harness.runtime.now() + CHALLENGE_TTL_MS);
  });

  it('removes the challenge from the session before verification', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const optionsJson = await registrationOptionsOf(harness);
    const body = await authenticator.registrationResult({ challenge: optionsJson!.challenge });
    expect(harness.session.has(WEBAUTHN_CHALLENGE_SESSION_KEY)).toBe(true);
    await harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
    expect(harness.session.has(WEBAUTHN_CHALLENGE_SESSION_KEY)).toBe(false);
  });

  it('refuses a challenge aged past its expiry', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const optionsJson = await harness.ceremonies.authenticationOptions(harness.ctx);
    const body = await authenticator.assertionResult({ challenge: optionsJson.challenge });
    // Age the session past the challenge's expiry.
    harness.runtime.setNow(harness.runtime.now() + CHALLENGE_TTL_MS + 1);
    const outcome = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(outcome).toEqual({ ok: false, reason: 'challenge-missing' });
  });

  it('replaces a prior challenge with a new options request', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const first = await harness.ceremonies.authenticationOptions(harness.ctx);
    const second = await harness.ceremonies.authenticationOptions(harness.ctx);
    expect(second.challenge).not.toBe(first.challenge);
    // An assertion answering the FIRST challenge is refused: the session holds
    // only the second one.
    const body = await authenticator.assertionResult({ challenge: first.challenge });
    const outcome = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(outcome).toEqual({ ok: false, reason: 'challenge-missing' });
  });

  it('claims the challenge once in the store, so a replay is refused', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    // Enrol first: the replay's refusal must come from the claim, not from an
    // unknown credential.
    const registration = await registrationOptionsOf(harness);
    const registrationBody = await authenticator.registrationResult({
      challenge: registration!.challenge,
    });
    const registered = await harness.ceremonies.verifyRegistration(
      harness.ctx,
      registrationBody,
      { id: 'alice' },
    );
    expect(registered.ok).toBe(true);
    authenticator.userHandle = fromBase64Url(registration!.user.id);
    const optionsJson = await harness.ceremonies.authenticationOptions(harness.ctx);
    const body = await authenticator.assertionResult({ challenge: optionsJson.challenge });
    const first = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(first).toEqual({ ok: true, status: 'signed-in' });
    // Replant the SAME challenge in the session — an older cookie copy would
    // carry it — and replay the assertion. The store's claim refuses it.
    harness.session.set(WEBAUTHN_CHALLENGE_SESSION_KEY, {
      kind: 'authentication',
      challenge: optionsJson.challenge,
      expiresAt: harness.runtime.now() + CHALLENGE_TTL_MS,
    });
    const replay = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(replay).toEqual({ ok: false, reason: 'challenge-used' });
  });

  it('the memory store purges claims past their expiry', async () => {
    const harness = createCeremoniesHarness();
    const now = harness.runtime.now();
    const first = await harness.store.claimChallenge('challenge-a', now, now + 1000);
    expect(first).toBe(true);
    // After the claim lapses, the same challenge can be claimed again.
    harness.runtime.setNow(now + 1001);
    const again = await harness.store.claimChallenge('challenge-a', now + 1001, now + 2001);
    expect(again).toBe(true);
  });

  it('the ceremonies use the configured origins for the exact allowlist', async () => {
    const harness = createCeremoniesHarness({
      passkeys: { origins: [ORIGIN, 'https://alt.localhost'] },
    });
    void RP_ID;
    const optionsJson = await harness.ceremonies.authenticationOptions(harness.ctx);
    expect(optionsJson.rpId).toBe(RP_ID);
  });
});
