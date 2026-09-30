/**
 * Algorithm checks, key selection and signature verification for tokens from
 * an outside issuer. Internal: not exported from the package barrel.
 *
 * Every check here runs BEFORE a key is used. The algorithm is checked before
 * any key is looked up, so `none` and every HMAC algorithm are refused without
 * touching the key set: an issuer's keys are asymmetric, and accepting an HMAC
 * `alg` against a public key is the algorithm-confusion attack.
 *
 * @module
 */

import type { IssuerAlgorithm } from '../interfaces/index.ts';
import { toBuffer } from '../utils/buffer.ts';

/** A JSON Web Key as read from a key set; every member is untrusted input. */
export type Jwk = Readonly<Record<string, unknown>>;

/** The five supported allowlist entries. */
export const SUPPORTED_ALGORITHMS: readonly IssuerAlgorithm[] = [
  'RS256',
  'PS256',
  'ES256',
  'ES384',
  'EdDSA',
];

interface AlgorithmSpec {
  readonly kty: string;
  readonly crv?: string;
  readonly importParams: RsaHashedImportParams | EcKeyImportParams | Algorithm;
  readonly verifyParams: RsaPssParams | EcdsaParams | Algorithm;
}

const SPECS: Readonly<Record<IssuerAlgorithm, AlgorithmSpec>> = {
  RS256: {
    kty: 'RSA',
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
  },
  PS256: {
    kty: 'RSA',
    importParams: { name: 'RSA-PSS', hash: 'SHA-256' },
    // RFC 7518 §3.5: the salt length equals the hash output length.
    verifyParams: { name: 'RSA-PSS', saltLength: 32 },
  },
  ES256: {
    kty: 'EC',
    crv: 'P-256',
    importParams: { name: 'ECDSA', namedCurve: 'P-256' },
    verifyParams: { name: 'ECDSA', hash: 'SHA-256' },
  },
  ES384: {
    kty: 'EC',
    crv: 'P-384',
    importParams: { name: 'ECDSA', namedCurve: 'P-384' },
    verifyParams: { name: 'ECDSA', hash: 'SHA-384' },
  },
  EdDSA: {
    kty: 'OKP',
    crv: 'Ed25519',
    importParams: { name: 'Ed25519' },
    verifyParams: { name: 'Ed25519' },
  },
};

/** Why a token's algorithm or key was refused. */
export type KeyRefusal = 'no-matching-key' | 'ambiguous-key';

/** Why a token's algorithm was refused. */
export type AlgorithmRefusal = 'algorithm-refused' | 'algorithm-not-allowed';

/**
 * Maps a token header `alg` to its allowlist family, or `null` when the
 * algorithm is refused outright or unsupported. `'Ed25519'` (RFC 9864) maps to
 * the `'EdDSA'` family.
 *
 * @param alg - The header `alg`, untrusted
 * @returns The family, or `null`
 */
export function algorithmFamily(alg: unknown): IssuerAlgorithm | null {
  if (typeof alg !== 'string') {
    return null;
  }
  if (alg === 'Ed25519') {
    return 'EdDSA';
  }
  return (SUPPORTED_ALGORITHMS as readonly string[]).includes(alg) ? alg as IssuerAlgorithm : null;
}

/**
 * Checks a header algorithm against an allowlist. `none` and every `HS*`
 * algorithm are refused whatever the allowlist says.
 *
 * @param alg - The header `alg`, untrusted
 * @param allowed - The issuer's allowlist
 * @returns The family, or the refusal reason
 */
export function checkAlgorithm(
  alg: unknown,
  allowed: ReadonlySet<IssuerAlgorithm>,
): IssuerAlgorithm | AlgorithmRefusal {
  if (typeof alg !== 'string' || alg.toLowerCase() === 'none' || alg.startsWith('HS')) {
    return 'algorithm-refused';
  }
  const family = algorithmFamily(alg);
  if (family === null || !allowed.has(family)) {
    return 'algorithm-not-allowed';
  }
  return family;
}

/**
 * Whether a key may verify a signature made with `family`.
 *
 * @param key - Candidate key
 * @param family - The token's algorithm family
 * @returns `true` when every filter passes
 */
function keyFits(key: Jwk, family: IssuerAlgorithm): boolean {
  const spec = SPECS[family];
  if (key.kty !== spec.kty) {
    return false;
  }
  if (spec.crv !== undefined && key.crv !== spec.crv) {
    return false;
  }
  if (key.use !== undefined && key.use !== 'sig') {
    return false;
  }
  if (key.alg !== undefined && algorithmFamily(key.alg) !== family) {
    return false;
  }
  if (key.key_ops !== undefined) {
    if (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify')) {
      return false;
    }
  }
  return true;
}

/**
 * Selects the single key that may verify a token.
 *
 * With a `kid`, the candidate must carry that `kid`. Without one, there must be
 * exactly one candidate after filtering.
 *
 * @param keys - The issuer's key set
 * @param family - The token's algorithm family
 * @param kid - The header `kid`, when present
 * @returns The key, or the refusal reason
 */
export function selectKey(
  keys: readonly Jwk[],
  family: IssuerAlgorithm,
  kid: string | undefined,
): Jwk | KeyRefusal {
  const candidates = keys.filter((key) =>
    keyFits(key, family) && (kid === undefined || key.kid === kid)
  );
  if (candidates.length === 0) {
    return 'no-matching-key';
  }
  if (candidates.length > 1) {
    return 'ambiguous-key';
  }
  return candidates[0];
}

/**
 * Builds the minimal JWK Web Crypto imports: only the key material, so a
 * provider's `alg`/`use`/`key_ops` spelling cannot make import fail.
 *
 * @param key - The selected key
 * @param family - The token's algorithm family
 * @returns The import-ready JWK
 */
function materialOf(key: Jwk, family: IssuerAlgorithm): JsonWebKey {
  const spec = SPECS[family];
  if (spec.kty === 'RSA') {
    return { kty: 'RSA', n: String(key.n), e: String(key.e) };
  }
  if (spec.kty === 'EC') {
    return { kty: 'EC', crv: String(key.crv), x: String(key.x), y: String(key.y) };
  }
  return { kty: 'OKP', crv: 'Ed25519', x: String(key.x) };
}

/**
 * Verifies a signature over `signingInput` with the selected key. Imported
 * keys are cached per key object and family.
 *
 * ECDSA signatures in a JWS are the raw `r‖s` form Web Crypto expects, so no
 * DER conversion is needed.
 */
export class SignatureVerifier {
  readonly #subtle: SubtleCrypto;
  readonly #cache = new WeakMap<Jwk, Map<IssuerAlgorithm, Promise<CryptoKey>>>();

  /**
   * @param subtle - Web Crypto, from `IRuntimeServices.subtle`
   */
  constructor(subtle: SubtleCrypto) {
    this.#subtle = subtle;
  }

  /**
   * @param key - The selected key
   * @param family - The token's algorithm family
   * @param signature - The decoded signature
   * @param signingInput - `<header>.<payload>` as bytes
   * @returns `true` when the signature verifies; `false` on any failure
   */
  async verify(
    key: Jwk,
    family: IssuerAlgorithm,
    signature: Uint8Array,
    signingInput: Uint8Array,
  ): Promise<boolean> {
    try {
      const cryptoKey = await this.#importKey(key, family);
      return await this.#subtle.verify(
        SPECS[family].verifyParams,
        cryptoKey,
        toBuffer(signature),
        toBuffer(signingInput),
      );
    } catch {
      return false;
    }
  }

  #importKey(key: Jwk, family: IssuerAlgorithm): Promise<CryptoKey> {
    let byFamily = this.#cache.get(key);
    if (byFamily === undefined) {
      byFamily = new Map();
      this.#cache.set(key, byFamily);
    }
    let pending = byFamily.get(family);
    if (pending === undefined) {
      pending = this.#subtle.importKey(
        'jwk',
        materialOf(key, family),
        SPECS[family].importParams,
        false,
        ['verify'],
      );
      // A failed import is not cached, so a later retry is possible.
      pending.catch(() => byFamily.delete(family));
      byFamily.set(family, pending);
    }
    return pending;
  }
}
