import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { decodeCbor } from '../../src/passkeys/cbor.ts';
import {
  algorithmName,
  coseAlgorithm,
  coseKeyToJwk,
  isOnP256,
} from '../../src/passkeys/cose-key.ts';
import {
  coseKeyBytes,
  encodeByteString,
  encodeMap,
  encodeNegative,
  encodeUint,
  KTY_EC2,
} from '../fixtures/virtual-authenticator.ts';

describe('algorithmName', () => {
  it('maps the three accepted COSE algorithms', () => {
    expect(algorithmName(-7)).toBe('ES256');
    expect(algorithmName(-257)).toBe('RS256');
    expect(algorithmName(-8)).toBe('EdDSA');
  });

  it('refuses every other algorithm', () => {
    expect(algorithmName(-47)).toBeNull();
    expect(algorithmName(-258)).toBeNull();
    expect(algorithmName(7)).toBeNull();
  });
});

describe('coseAlgorithm', () => {
  it('reads the alg label from a decoded COSE key', () => {
    const decoded = decodeCbor(coseKeyBytes('ES256', {
      crv: 'P-256',
      x: 'AAA',
      y: 'AAA',
      kty: 'EC',
    }));
    expect(decoded.ok && coseAlgorithm(decoded.value)).toBe('ES256');
  });

  it('refuses a non-map or a missing label', () => {
    expect(coseAlgorithm('not a map')).toBeNull();
    expect(coseAlgorithm(new Map())).toBeNull();
  });
});

describe('coseKeyToJwk', () => {
  it('converts an EC2/P-256 key to a JWK', async () => {
    // A generated key: the converter now refuses a point off the curve, which a
    // hand-written coordinate pair almost always is.
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const x = exported.x!;
    const y = exported.y!;
    const decoded = decodeCbor(coseKeyBytes('ES256', { kty: 'EC', crv: 'P-256', x, y }));
    expect(decoded.ok).toBe(true);
    const jwk = decoded.ok ? coseKeyToJwk(decoded.value, 'ES256') : null;
    expect(jwk).toEqual({ kty: 'EC', crv: 'P-256', x, y, key_ops: ['verify'], ext: true });
  });

  it('converts an RSA key to a JWK', () => {
    const n = 'A'.repeat(342); // 256 bytes base64url
    const decoded = decodeCbor(
      coseKeyBytes('RS256', { kty: 'RSA', n, e: 'AQAB' }),
    );
    expect(decoded.ok).toBe(true);
    const jwk = decoded.ok ? coseKeyToJwk(decoded.value, 'RS256') : null;
    expect(jwk?.kty).toBe('RSA');
    expect(jwk?.n).toBe(n);
    expect(jwk?.e).toBe('AQAB');
  });

  it('converts an OKP/Ed25519 key to a JWK', () => {
    const x = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
    const decoded = decodeCbor(coseKeyBytes('EdDSA', { kty: 'OKP', crv: 'Ed25519', x }));
    expect(decoded.ok).toBe(true);
    const jwk = decoded.ok ? coseKeyToJwk(decoded.value, 'EdDSA') : null;
    expect(jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x, key_ops: ['verify'], ext: true });
  });

  it('refuses a key type that does not match the algorithm', () => {
    const rsa = decodeCbor(coseKeyBytes('RS256', { kty: 'RSA', n: 'A'.repeat(342), e: 'AQAB' }));
    expect(rsa.ok && coseKeyToJwk(rsa.value, 'ES256')).toBeNull();
  });

  it('refuses a wrong curve', () => {
    // A P-384 curve label under an ES256 credential
    const cose = encodeMap([
      [encodeUint(1), encodeUint(KTY_EC2)],
      [encodeUint(3), encodeNegative(-7)],
      [encodeNegative(-1), encodeUint(2)], // P-384
      [encodeNegative(-2), encodeByteString(new Uint8Array(48))],
      [encodeNegative(-3), encodeByteString(new Uint8Array(48))],
    ]);
    const decoded = decodeCbor(cose);
    expect(decoded.ok && coseKeyToJwk(decoded.value, 'ES256')).toBeNull();
  });

  it('refuses a wrong coordinate length', () => {
    const decoded = decodeCbor(coseKeyBytes('ES256', {
      kty: 'EC',
      crv: 'P-256',
      x: 'wrong-length',
      y: 'wrong-length',
    }));
    expect(decoded.ok && coseKeyToJwk(decoded.value, 'ES256')).toBeNull();
  });

  it('refuses a short RSA modulus', () => {
    const decoded = decodeCbor(coseKeyBytes('RS256', { kty: 'RSA', n: 'AAA', e: 'AQAB' }));
    expect(decoded.ok && coseKeyToJwk(decoded.value, 'RS256')).toBeNull();
  });

  it('refuses a non-map key', () => {
    expect(coseKeyToJwk('not a map', 'ES256')).toBeNull();
    expect(coseKeyToJwk(42, 'RS256')).toBeNull();
  });

  it('isOnP256 accepts a real point and refuses off-curve and out-of-field coordinates', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const x = raw.slice(1, 33);
    const y = raw.slice(33, 65);
    expect(isOnP256(x, y)).toBe(true);
    const tweaked = y.slice();
    tweaked[31] = tweaked[31]! ^ 1;
    expect(isOnP256(x, tweaked)).toBe(false);
    // A coordinate at or above the field prime is refused before the equation.
    expect(isOnP256(new Uint8Array(32).fill(0xff), y)).toBe(false);
    expect(isOnP256(x, new Uint8Array(32).fill(0xff))).toBe(false);
  });
});
