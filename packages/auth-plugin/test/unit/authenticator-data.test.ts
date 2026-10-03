import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { parseAuthenticatorData } from '../../src/passkeys/authenticator-data.ts';
import { buildAuthData } from '../fixtures/virtual-authenticator.ts';

describe('parseAuthenticatorData', () => {
  it('parses the flags and the big-endian counter', async () => {
    const bytes = await buildAuthData({ rpId: 'localhost', counter: 16909060, uv: true });
    const parsed = parseAuthenticatorData(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed?.userPresent).toBe(true);
    expect(parsed?.userVerified).toBe(true);
    expect(parsed?.backedUp).toBe(false);
    expect(parsed?.signCounter).toBe(16909060);
    expect(parsed?.attestedCredentialDataIncluded).toBe(false);
  });

  it('parses the backed-up flag', async () => {
    const parsed = parseAuthenticatorData(
      await buildAuthData({ rpId: 'localhost', backedUp: true }),
    );
    expect(parsed?.backedUp).toBe(true);
  });

  it('carries the raw RP ID hash for the caller to compare', async () => {
    const parsed = parseAuthenticatorData(await buildAuthData({ rpId: 'localhost' }));
    expect(parsed?.rpIdHash).toBeInstanceOf(Uint8Array);
    expect(parsed?.rpIdHash.length).toBe(32);
  });

  it('parses attested credential data with its COSE key', async () => {
    const credentialId = new Uint8Array([1, 2, 3, 4]);
    const coseKey = new Uint8Array([
      0xa4,
      0x01,
      0x02,
      0x03,
      0x26,
      0x20,
      0x01,
      0x21,
      0x43,
      0x01,
      0x02,
      0x03,
      0x22,
      0x43,
      0x04,
      0x05,
      0x06,
    ]);
    const parsed = parseAuthenticatorData(
      await buildAuthData({ rpId: 'localhost', credentialId, coseKey, uv: true }),
    );
    expect(parsed?.attestedCredentialDataIncluded).toBe(true);
    expect(parsed?.credentialId).toEqual(credentialId);
    expect(parsed?.credentialPublicKey).toBeDefined();
  });

  it('refuses truncated input', () => {
    expect(parseAuthenticatorData(new Uint8Array(36))).toBeNull();
    expect(parseAuthenticatorData(new Uint8Array(0))).toBeNull();
  });

  it('refuses attested credential data with a truncated id', async () => {
    const credentialId = new Uint8Array(4);
    const coseKey = new Uint8Array([0xa0]);
    const bytes = await buildAuthData({ rpId: 'localhost', credentialId, coseKey });
    // Truncate inside the credential id.
    const truncated = bytes.slice(0, 40);
    expect(parseAuthenticatorData(truncated)).toBeNull();
  });

  it('refuses a zero-length credential id', async () => {
    // Hand-build the length field as zero.
    const bytes = await buildAuthData({
      rpId: 'localhost',
      credentialId: new Uint8Array(1),
      coseKey: new Uint8Array([0xa0]),
    });
    const patched = bytes.slice();
    // The length field sits at 37 + 16 = 53.
    patched[53] = 0;
    patched[54] = 0;
    expect(parseAuthenticatorData(patched)).toBeNull();
  });
});
