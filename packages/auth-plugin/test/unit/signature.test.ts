import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  concatBytes,
  derToRawSignature,
  verifyPasskeySignature,
} from '../../src/passkeys/signature.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { VirtualAuthenticator } from '../fixtures/virtual-authenticator.ts';

describe('derToRawSignature', () => {
  it('converts a valid DER signature to the raw r‖s form', () => {
    // SEQUENCE { INTEGER 1, INTEGER 2 }
    const der = new Uint8Array([
      0x30,
      0x06,
      0x02,
      0x01,
      0x01,
      0x02,
      0x01,
      0x02,
    ]);
    const raw = derToRawSignature(der);
    expect(raw).not.toBeNull();
    expect(raw?.length).toBe(64);
    // r = 1 in the last byte of the first 32; s = 2 in the last byte of the second.
    expect(raw?.[31]).toBe(1);
    expect(raw?.[63]).toBe(2);
  });

  it('strips the sign-bit leading zero and left-pads each scalar', () => {
    // r = 0x80 (needs a leading 0x00 in DER), s = 0xFF
    const der = new Uint8Array([
      0x30,
      0x08,
      0x02,
      0x02,
      0x00,
      0x80,
      0x02,
      0x02,
      0x00,
      0xff,
    ]);
    const raw = derToRawSignature(der);
    expect(raw).not.toBeNull();
    expect(raw?.[31]).toBe(0x80);
    expect(raw?.[63]).toBe(0xff);
    // The stripped zeros left-pad the scalars: byte 0 is 0x00.
    expect(raw?.[0]).toBe(0x00);
  });

  it('refuses a non-SEQUENCE input', () => {
    expect(derToRawSignature(new Uint8Array([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02])))
      .toBeNull();
  });

  it('refuses a wrong body length', () => {
    const der = new Uint8Array([
      0x30,
      0x07,
      0x02,
      0x01,
      0x01,
      0x02,
      0x01,
      0x02,
      0x00,
    ]);
    expect(derToRawSignature(der)).toBeNull();
  });

  it('refuses a truncated input', () => {
    expect(derToRawSignature(new Uint8Array([0x30, 0x06, 0x02, 0x01]))).toBeNull();
    expect(derToRawSignature(new Uint8Array())).toBeNull();
  });

  it('refuses a non-INTEGER element', () => {
    const der = new Uint8Array([
      0x30,
      0x06,
      0x04,
      0x01,
      0x01,
      0x02,
      0x01,
      0x02,
    ]);
    expect(derToRawSignature(der)).toBeNull();
  });
});

describe('verifyPasskeySignature', () => {
  const runtime = createFakeRuntime();

  it('verifies a real ES256 signature produced by the virtual authenticator', async () => {
    const authenticator = await VirtualAuthenticator.create('ES256');
    const authenticatorData = new Uint8Array(37);
    const signed = concatBytes(
      authenticatorData,
      new Uint8Array(await runtime.subtle.digest('SHA-256', new TextEncoder().encode('{"a":1}'))),
    );
    // The authenticator emits DER; the verifier converts it to raw first.
    const derSignature = await authenticator.sign(signed);
    const rawSignature = derToRawSignature(derSignature);
    expect(rawSignature).not.toBeNull();
    const jwk = await authenticator.publicKeyJwk();
    const verified = await verifyPasskeySignature(
      runtime,
      'ES256',
      jwk,
      signed,
      rawSignature!,
    );
    expect(verified).toBe(true);
  });

  it('refuses a signature over different data', async () => {
    const authenticator = await VirtualAuthenticator.create('ES256');
    const signature = await authenticator.sign(new Uint8Array(37));
    const jwk = await authenticator.publicKeyJwk();
    const verified = await verifyPasskeySignature(
      runtime,
      'ES256',
      jwk,
      new Uint8Array(38),
      signature,
    );
    expect(verified).toBe(false);
  });

  it('verifies a real RS256 signature', async () => {
    const authenticator = await VirtualAuthenticator.create('RS256');
    const signature = await authenticator.sign(new Uint8Array(37));
    const jwk = await authenticator.publicKeyJwk();
    const verified = await verifyPasskeySignature(
      runtime,
      'RS256',
      jwk,
      new Uint8Array(37),
      signature,
    );
    expect(verified).toBe(true);
  });

  it('verifies a real EdDSA signature', async () => {
    const authenticator = await VirtualAuthenticator.create('EdDSA');
    const signature = await authenticator.sign(new Uint8Array(37));
    const jwk = await authenticator.publicKeyJwk();
    const verified = await verifyPasskeySignature(
      runtime,
      'EdDSA',
      jwk,
      new Uint8Array(37),
      signature,
    );
    expect(verified).toBe(true);
  });

  it('refuses a malformed stored key rather than throwing', async () => {
    const verified = await verifyPasskeySignature(
      runtime,
      'ES256',
      { kty: 'EC', crv: 'P-256', x: '!!!', y: '!!!' },
      new Uint8Array(37),
      new Uint8Array(64),
    );
    expect(verified).toBe(false);
  });
});
