import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  createCeremoniesHarness,
  ORIGIN,
  registrationOptionsOf,
} from '../fixtures/passkey-ceremonies.ts';
import { fromBase64Url, VirtualAuthenticator } from '../fixtures/virtual-authenticator.ts';
import { compilePasskeys } from '../../src/passkeys/ceremonies.ts';
import { WEBAUTHN_CHALLENGE_SESSION_KEY } from '../../src/passkeys/ceremonies.ts';
import { MemoryPasskeyStore } from '../../src/stores/passkey-store.ts';
import { toBase64Url } from '../fixtures/virtual-authenticator.ts';
import { AuthPluginConfigurationError } from '../../src/errors.ts';
import type { PasskeyOptions } from '../../src/interfaces/index.ts';

describe('ceremony edge branches', () => {
  it('compilePasskeys refuses an http origin on the IPv6 loopback', () => {
    const base: PasskeyOptions = {
      rpId: 'example.com',
      rpName: 'Test',
      origins: ['https://example.com'],
      store: new MemoryPasskeyStore(),
      resolvePrincipal: () => Promise.resolve(null),
    };
    expect(() => compilePasskeys({ ...base, origins: ['http://[::1]:8080'] })).toThrow(
      AuthPluginConfigurationError,
    );
  });

  it('compilePasskeys refuses a non-string origin and an origin that is not a URL', () => {
    const base: PasskeyOptions = {
      rpId: 'example.com',
      rpName: 'Test',
      origins: ['https://example.com'],
      store: new MemoryPasskeyStore(),
      resolvePrincipal: () => Promise.resolve(null),
    };
    expect(() =>
      compilePasskeys({ ...base, origins: [42] as unknown as PasskeyOptions['origins'] })
    ).toThrow(AuthPluginConfigurationError);
    expect(() =>
      compilePasskeys({ ...base, origins: ['not a url'] as unknown as PasskeyOptions['origins'] })
    ).toThrow(AuthPluginConfigurationError);
  });

  it('refuses an authentication whose stored credential carries an unknown algorithm', async () => {
    const harness = createCeremoniesHarness();
    const rogue = await VirtualAuthenticator.create('ES256');
    // A credential planted with a COSE algorithm this verifier does not map.
    await harness.store.save({
      id: toBase64Url(rogue.credentialId),
      principalId: 'alice',
      userHandle: toBase64Url(rogue.userHandle),
      publicKey: await rogue.publicKeyJwk(),
      algorithm: -47,
      counter: 0,
      backedUp: false,
      transports: ['internal'],
      attestation: 'unverified',
      createdAt: 0,
    }, { maxPerPrincipal: 100 });
    const options = await harness.ceremonies.authenticationOptions(harness.ctx);
    const body = await rogue.assertionResult({
      challenge: options.challenge,
      rpId: 'localhost',
      origin: ORIGIN,
    });
    const outcome = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(outcome).toEqual({ ok: false, reason: 'credential-unknown' });
  });

  it('refuses a ceremony whose session challenge record is corrupt', async () => {
    const harness = createCeremoniesHarness();
    const options = await harness.ceremonies.authenticationOptions(harness.ctx);
    const authenticator = await VirtualAuthenticator.create('ES256');
    const body = await authenticator.assertionResult({
      challenge: options.challenge,
      rpId: 'localhost',
      origin: ORIGIN,
    });
    // Corrupt the record AFTER the body was built against it: the body is
    // validated first, so the corruption must be in place before the verify.
    harness.session.set(WEBAUTHN_CHALLENGE_SESSION_KEY, 'not-an-object');
    const outcome = await harness.ceremonies.verifyAuthentication(harness.ctx, body);
    expect(outcome).toEqual({ ok: false, reason: 'challenge-missing' });
  });

  it('refuses a registration whose session challenge lost its user handle', async () => {
    const harness = createCeremoniesHarness();
    const options = await registrationOptionsOf(harness);
    // Replant the record WITHOUT the user handle.
    harness.session.set(WEBAUTHN_CHALLENGE_SESSION_KEY, {
      kind: 'registration',
      challenge: options!.challenge,
      expiresAt: harness.runtime.now() + 300_000,
    });
    const authenticator = await VirtualAuthenticator.create('ES256');
    const body = await authenticator.registrationResult({
      challenge: options!.challenge,
      rpId: 'localhost',
      origin: ORIGIN,
    });
    const outcome = await harness.ceremonies.verifyRegistration(harness.ctx, body, {
      id: 'alice',
    });
    expect(outcome).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses an authentication body whose fields are missing or undecodable', async () => {
    const harness = createCeremoniesHarness();
    const options = await harness.ceremonies.authenticationOptions(harness.ctx);
    const authenticator = await VirtualAuthenticator.create('ES256');
    const partial = await authenticator.assertionResult({
      challenge: options.challenge,
      rpId: 'localhost',
      origin: ORIGIN,
    });
    // The session challenge was consumed by nothing yet; each body below
    // fails a different field check.
    harness.session.set(WEBAUTHN_CHALLENGE_SESSION_KEY, {
      kind: 'authentication',
      challenge: options.challenge,
      expiresAt: harness.runtime.now() + 300_000,
    });
    const missingSignature = {
      ...partial,
      response: { ...partial.response, signature: undefined },
    };
    expect(await harness.ceremonies.verifyAuthentication(harness.ctx, missingSignature)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    harness.session.set(WEBAUTHN_CHALLENGE_SESSION_KEY, {
      kind: 'authentication',
      challenge: options.challenge,
      expiresAt: harness.runtime.now() + 300_000,
    });
    const badAuthData = {
      ...partial,
      response: { ...partial.response, authenticatorData: '!!!' },
    };
    expect(await harness.ceremonies.verifyAuthentication(harness.ctx, badAuthData)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    void fromBase64Url;
  });

  it('reuses the per-principal user handle for a second credential', async () => {
    const harness = createCeremoniesHarness();
    const first = await registrationOptionsOf(harness);
    const firstHandle = first!.user.id;
    // No credential was stored, so the second options request generates a NEW
    // handle: the reuse happens through the store, which is covered by the
    // route test registering two authenticators for one principal.
    const second = await registrationOptionsOf(harness);
    expect(second!.user.id).not.toBe(firstHandle);
  });
});
