import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  createCeremoniesHarness,
  ORIGIN,
  registrationOptionsOf,
} from '../fixtures/passkey-ceremonies.ts';
import type { CeremoniesHarness } from '../fixtures/passkey-ceremonies.ts';
import type { IAuthSessionService, ISessionService } from '@setu-ts/common';
import { MemoryPasskeyStore } from '../../src/stores/passkey-store.ts';
import type { IPasskeyStore } from '../../src/stores/passkey-store.ts';
import {
  coseKeyBytes,
  toBase64Url,
  VirtualAuthenticator,
} from '../fixtures/virtual-authenticator.ts';
import { MAX_CREDENTIALS_PER_PRINCIPAL, PasskeyCeremonies } from '../../src/passkeys/ceremonies.ts';
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
  const optionsJson = await registrationOptionsOf(harness);
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
    const optionsJson = await registrationOptionsOf(harness);
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
    const optionsJson = await registrationOptionsOf(harness);
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
    const optionsJson = await registrationOptionsOf(harness);
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
    await registrationOptionsOf(harness);
    const outcome = await harness.ceremonies.verifyRegistration(harness.ctx, {}, { id: 'alice' });
    expect(outcome).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a second registration with a consumed challenge', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const optionsJson = await registrationOptionsOf(harness);
    const body = await authenticator.registrationResult({ challenge: optionsJson!.challenge });
    const first = await harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
    expect(first.ok).toBe(true);
    // The session challenge is gone; the same body replayed is refused.
    const replay = await harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
    expect(replay).toEqual({ ok: false, reason: 'challenge-missing' });
  });

  it('keeps only defined transport values, once each', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const huge = 'x'.repeat(100_000);
    const outcome = await register(harness, authenticator, {
      transports: ['usb', huge, 'usb', 'internal', 'bogus', 'nfc'],
    });
    expect(outcome.ok).toBe(true);
    const [stored] = await harness.store.listByPrincipal('alice');
    expect(stored?.transports).toEqual(['usb', 'internal', 'nfc']);
  });

  it('refuses a key the runtime will not import (an EC point off the curve)', async () => {
    const harness = createCeremoniesHarness();
    const authenticator = await VirtualAuthenticator.create('ES256');
    const jwk = await authenticator.publicKeyJwk();
    // Same shape and lengths, but (x, y) = (1, 1) is not on P-256.
    const one = new Uint8Array(32);
    one[31] = 1;
    const offCurve = coseKeyBytes('ES256', {
      ...jwk,
      x: toBase64Url(one),
      y: toBase64Url(one),
    });
    const outcome = await register(harness, authenticator, { coseKeyOverride: offCurve });
    expect(outcome).toEqual({ ok: false, reason: 'malformed' });
    expect(await harness.store.listByPrincipal('alice')).toEqual([]);
  });

  it('caps the credentials one principal may hold', async () => {
    const harness = createCeremoniesHarness();
    for (let i = 0; i < MAX_CREDENTIALS_PER_PRINCIPAL; i++) {
      await harness.store.save({
        id: `seed-${i}`,
        principalId: 'alice',
        userHandle: 'h',
        publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
        algorithm: -8,
        counter: 0,
        backedUp: false,
        transports: [],
        attestation: 'unverified',
        createdAt: 0,
      }, { maxPerPrincipal: 100 });
    }
    expect(await harness.ceremonies.registrationOptions(harness.ctx)).toBe('credential-limit');
    const authenticator = await VirtualAuthenticator.create('ES256');
    const body = await authenticator.registrationResult({ challenge: 'x' });
    const outcome = await harness.ceremonies.verifyRegistration(harness.ctx, body, { id: 'alice' });
    expect(outcome).toEqual({ ok: false, reason: 'credential-limit' });
  });

  it('refuses a second credential from a session without a second factor', async () => {
    const harness = createCeremoniesHarness({ methods: ['pwd'] });
    // The first credential is trusted on first use.
    expect((await register(harness, await VirtualAuthenticator.create('ES256'))).ok).toBe(true);
    expect(await harness.ceremonies.registrationOptions(harness.ctx)).toBe(
      'second-factor-required',
    );
  });

  it('fails closed when the sign-in owner cannot report the recorded methods', async () => {
    const harness = createCeremoniesHarness();
    expect((await register(harness, await VirtualAuthenticator.create('ES256'))).ok).toBe(true);
    // A third-party IAuthSessionService without the package's internal seam.
    const opaque: IAuthSessionService = {
      signIn: (ctx, principal, options) => harness.authSession.signIn(ctx, principal, options),
      current: (ctx) => harness.authSession.current(ctx),
      pending: (ctx) => harness.authSession.pending(ctx),
      signOut: (ctx) => harness.authSession.signOut(ctx),
    };
    const ceremonies = new PasskeyCeremonies({
      config: harness.config,
      runtime: harness.runtime,
      sessionService: { from: () => harness.session } as unknown as ISessionService,
      authSession: opaque,
    });
    expect(await ceremonies.registrationOptions(harness.ctx)).toBe('second-factor-required');
  });

  it("maps the store's atomic 'limit' answer to credential-limit", async () => {
    // A concurrent ceremony filled the principal between the count check and
    // the write: the store, not the pre-check, is what refuses.
    const inner = new MemoryPasskeyStore();
    const racing: IPasskeyStore = {
      listByPrincipal: (id) => inner.listByPrincipal(id),
      findById: (id) => inner.findById(id),
      save: (credential, options) => {
        expect(credential.principalId).toBe('alice');
        expect(options).toEqual({ maxPerPrincipal: MAX_CREDENTIALS_PER_PRINCIPAL });
        return Promise.resolve('limit');
      },
      updateCounter: (id, observed) => inner.updateCounter(id, observed),
      delete: (id) => inner.delete(id),
      claimChallenge: (c, now, exp) => inner.claimChallenge(c, now, exp),
    };
    const harness = createCeremoniesHarness({ passkeys: { store: racing } });
    const outcome = await register(harness, await VirtualAuthenticator.create('ES256'));
    expect(outcome).toEqual({ ok: false, reason: 'credential-limit' });
  });
});
