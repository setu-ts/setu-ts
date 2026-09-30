import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  algorithmFamily,
  checkAlgorithm,
  selectKey,
  SignatureVerifier,
  SUPPORTED_ALGORITHMS,
} from '../../src/issuers/key-selection.ts';
import type { IssuerAlgorithm } from '../../src/interfaces/index.ts';
import { decodeBase64Url } from '../../src/utils/base64url.ts';
import { generateTestKey, signToken } from '../fixtures/issuer-tokens.ts';

const ALL = new Set<IssuerAlgorithm>(SUPPORTED_ALGORITHMS);

function parts(token: string): { input: Uint8Array; signature: Uint8Array } {
  const [h, p, s] = token.split('.');
  return { input: new TextEncoder().encode(`${h}.${p}`), signature: decodeBase64Url(s) };
}

describe('checkAlgorithm', () => {
  it('refuses none and every HMAC algorithm whatever the allowlist says', () => {
    for (const alg of ['none', 'NONE', 'HS256', 'HS384', 'HS512']) {
      expect(checkAlgorithm(alg, ALL)).toBe('algorithm-refused');
    }
    expect(checkAlgorithm(undefined, ALL)).toBe('algorithm-refused');
  });

  it('refuses a supported algorithm outside the allowlist and an unknown one', () => {
    expect(checkAlgorithm('ES256', new Set<IssuerAlgorithm>(['RS256']))).toBe(
      'algorithm-not-allowed',
    );
    expect(checkAlgorithm('RS512', ALL)).toBe('algorithm-not-allowed');
  });

  it('admits the fully-specified Ed25519 spelling under EdDSA', () => {
    expect(checkAlgorithm('Ed25519', new Set<IssuerAlgorithm>(['EdDSA']))).toBe('EdDSA');
    expect(algorithmFamily('Ed25519')).toBe('EdDSA');
    expect(algorithmFamily(7)).toBeNull();
  });
});

describe('selectKey', () => {
  const rsa = { kty: 'RSA', kid: 'sig', use: 'sig', alg: 'RS256', n: 'n', e: 'AQAB' };
  // Keycloak publishes an RSA encryption key beside the signing key.
  const enc = { kty: 'RSA', kid: 'enc', use: 'enc', alg: 'RSA-OAEP', n: 'n', e: 'AQAB' };

  it('ignores an encryption key and selects the signing key by kid', () => {
    expect(selectKey([enc, rsa], 'RS256', 'sig')).toBe(rsa);
    expect(selectKey([enc, rsa], 'RS256', 'enc')).toBe('no-matching-key');
  });

  it('selects the only candidate without a kid, and refuses ambiguity', () => {
    expect(selectKey([enc, rsa], 'RS256', undefined)).toBe(rsa);
    expect(selectKey([rsa, { ...rsa, kid: 'other' }], 'RS256', undefined)).toBe('ambiguous-key');
  });

  it('filters by key_ops, key alg and curve', () => {
    expect(selectKey([{ ...rsa, key_ops: ['encrypt'] }], 'RS256', 'sig')).toBe('no-matching-key');
    expect(selectKey([{ ...rsa, key_ops: 'verify' }], 'RS256', 'sig')).toBe('no-matching-key');
    expect(selectKey([{ ...rsa, key_ops: ['verify'] }], 'RS256', 'sig')).not.toBe(
      'no-matching-key',
    );
    expect(selectKey([rsa], 'PS256', 'sig')).toBe('no-matching-key');
    const p384 = { kty: 'EC', crv: 'P-384', kid: 'ec', x: 'x', y: 'y' };
    expect(selectKey([p384], 'ES256', 'ec')).toBe('no-matching-key');
    expect(selectKey([p384], 'ES384', 'ec')).toBe(p384);
  });
});

describe('SignatureVerifier (real crypto)', () => {
  const verifier = new SignatureVerifier(crypto.subtle);

  for (const alg of SUPPORTED_ALGORITHMS) {
    it(`verifies ${alg} from a JWK and rejects a tampered payload`, async () => {
      const key = await generateTestKey(alg, `k-${alg}`);
      const token = await signToken(key, { sub: 'u1' });
      const { input, signature } = parts(token);
      expect(await verifier.verify(key.jwk, alg, signature, input)).toBe(true);
      const tampered = new TextEncoder().encode(`${token.split('.')[0]}.eyJzdWIiOiJ1MiJ9`);
      expect(await verifier.verify(key.jwk, alg, signature, tampered)).toBe(false);
    });
  }

  it('verifies a token whose header says alg Ed25519', async () => {
    const key = await generateTestKey('EdDSA', 'ed');
    const token = await signToken({ ...key, alg: 'Ed25519' }, { sub: 'u1' });
    const { input, signature } = parts(token);
    expect(await verifier.verify(key.jwk, 'EdDSA', signature, input)).toBe(true);
  });

  it('returns false rather than throwing for unimportable material, then retries', async () => {
    const broken = { kty: 'EC', crv: 'P-256', x: 'bad', y: 'bad' };
    const input = new Uint8Array([1]);
    expect(await verifier.verify(broken, 'ES256', new Uint8Array(64), input)).toBe(false);
    expect(await verifier.verify(broken, 'ES256', new Uint8Array(64), input)).toBe(false);
  });

  it('refuses an ES256 signature against a P-384 key', async () => {
    const es256 = await generateTestKey('ES256', 'a');
    const es384 = await generateTestKey('ES384', 'a');
    const { input, signature } = parts(await signToken(es256, { sub: 'u' }));
    expect(selectKey([es384.jwk], 'ES256', 'a')).toBe('no-matching-key');
    expect(await verifier.verify(es384.jwk, 'ES384', signature, input)).toBe(false);
  });
});
