/**
 * COSE key to JWK conversion for the algorithms WebAuthn Level 2 attestation
 * `none` can produce and this verifier accepts (plan §3.1): EC2/P-256 (ES256),
 * RSA (RS256) and OKP/Ed25519 (EdDSA).
 *
 * The COSE key lives inside `authenticatorData`'s attested credential data, so
 * it is the credential's key whatever attestation statement the client chose to
 * send — which is why the conversion, not the statement, is the trust anchor.
 *
 * @module
 */

import type { CborValue } from './cbor.ts';
import { encodeBase64Url } from '../utils/base64url.ts';

/** The signature algorithms this verifier accepts, by their JWK names. */
export type PasskeyAlgorithm = 'ES256' | 'RS256' | 'EdDSA';

/** The COSE algorithm identifiers this verifier accepts (plan §3.2). */
export const COSE_ALGORITHMS: readonly number[] = [-8, -7, -257];

/** Maps a COSE algorithm identifier to its JWK name, or `null` when refused. */
export function algorithmName(coseAlg: number): PasskeyAlgorithm | null {
  if (coseAlg === -7) {
    return 'ES256';
  }
  if (coseAlg === -257) {
    return 'RS256';
  }
  if (coseAlg === -8) {
    return 'EdDSA';
  }
  return null;
}

/** COSE key-type labels (RFC 9052 §7). */
const KTY = 1;
const ALG = 3;
/** COSE elliptic-curve labels. */
const CRV = -1;
/** COSE coordinate / modulus labels. */
const X = -2;
const Y = -3;
const N = -1;
const E = -2;

/** COSE key types. */
const KTY_EC2 = 2;
const KTY_RSA = 3;
const KTY_OKP = 1;

/** COSE curves. */
const CRV_P256 = 1;
const CRV_ED25519 = 6;

/** The expected byte length of a P-256 or Ed25519 coordinate. */
const COORDINATE_BYTES = 32;

/**
 * Reads an integer-labelled entry from a decoded COSE key map.
 *
 * @param cose - The decoded COSE key
 * @param label - The integer label
 * @returns The entry, or `null` when absent or of the wrong shape
 */
function entry(cose: ReadonlyMap<CborValue, CborValue>, label: number): CborValue | null {
  if (!cose.has(label)) {
    return null;
  }
  return cose.get(label) ?? null;
}

/** Whether `value` is a byte string of exactly `length` bytes. */
/** The P-256 field prime and curve coefficient `b` (SEC 2 §2.4.2); `a = -3`. */
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

/** A big-endian byte string as an unsigned integer. */
function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }
  return value;
}

/**
 * Whether `(x, y)` is a point on P-256: both coordinates below the field prime
 * and `y² ≡ x³ − 3x + b (mod p)`.
 *
 * Checked here rather than left to the runtime because the runtimes disagree:
 * measured, Node's Web Crypto refuses an off-curve JWK at import while Deno's
 * accepts it — so a credential that can never verify would be stored on one
 * runtime and refused on another.
 */
export function isOnP256(xBytes: Uint8Array, yBytes: Uint8Array): boolean {
  const x = toBigInt(xBytes);
  const y = toBigInt(yBytes);
  if (x >= P256_P || y >= P256_P) {
    return false;
  }
  const left = (y * y) % P256_P;
  const right = (((x * x % P256_P) * x - 3n * x + P256_B) % P256_P + P256_P) % P256_P;
  return left === right;
}

function isBytes(value: CborValue | null, length: number): value is Uint8Array {
  return value instanceof Uint8Array && value.length === length;
}

/** Whether `value` is the exact integer. */
function isInt(value: CborValue | null, expected: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value === expected;
}

/**
 * Converts a decoded COSE key to the JWK Web Crypto imports, refusing every
 * key type, curve and coordinate length outside the accepted set.
 *
 * The returned JWK carries only the members the algorithm needs, plus
 * `key_ops`/`ext` so an import call cannot disagree with a stored copy about
 * the key's permitted use.
 *
 * @param cose - The decoded COSE key (a map)
 * @param algorithm - The algorithm the credential declared
 * @returns The JWK, or `null` when the key is not one this verifier accepts
 */
export function coseKeyToJwk(
  cose: CborValue,
  algorithm: PasskeyAlgorithm,
): JsonWebKey | null {
  if (!(cose instanceof Map)) {
    return null;
  }
  const kty = entry(cose, KTY);
  if (algorithm === 'ES256') {
    if (!isInt(kty, KTY_EC2)) {
      return null;
    }
    if (!isInt(entry(cose, CRV), CRV_P256)) {
      return null;
    }
    const x = entry(cose, X);
    const y = entry(cose, Y);
    if (!isBytes(x, COORDINATE_BYTES) || !isBytes(y, COORDINATE_BYTES) || !isOnP256(x, y)) {
      return null;
    }
    return {
      kty: 'EC',
      crv: 'P-256',
      x: encodeBase64Url(x),
      y: encodeBase64Url(y),
      key_ops: ['verify'],
      ext: true,
    };
  }
  if (algorithm === 'RS256') {
    if (!isInt(kty, KTY_RSA)) {
      return null;
    }
    const n = entry(cose, N);
    const e = entry(cose, E);
    // A modulus under 2048 bits would be refused by the runtime's own import
    // anyway; the length floor here keeps a truncated key from reaching it as
    // a confusing platform error rather than a refusal of ours.
    if (!(n instanceof Uint8Array) || n.length < 256) {
      return null;
    }
    if (!(e instanceof Uint8Array) || e.length === 0) {
      return null;
    }
    return {
      kty: 'RSA',
      n: encodeBase64Url(n),
      e: encodeBase64Url(e),
      key_ops: ['verify'],
      ext: true,
    };
  }
  // EdDSA
  if (!isInt(kty, KTY_OKP)) {
    return null;
  }
  if (!isInt(entry(cose, CRV), CRV_ED25519)) {
    return null;
  }
  const x = entry(cose, X);
  if (!isBytes(x, COORDINATE_BYTES)) {
    return null;
  }
  return { kty: 'OKP', crv: 'Ed25519', x: encodeBase64Url(x), key_ops: ['verify'], ext: true };
}

/**
 * Reads the algorithm label out of a decoded COSE key and maps it to this
 * verifier's name, refusing an absent or unsupported label.
 *
 * @param cose - The decoded COSE key
 * @returns The algorithm name, or `null` when the label is absent or refused
 */
export function coseAlgorithm(cose: CborValue): PasskeyAlgorithm | null {
  if (!(cose instanceof Map)) {
    return null;
  }
  const alg = entry(cose, ALG);
  if (typeof alg !== 'number' || !Number.isInteger(alg)) {
    return null;
  }
  return algorithmName(alg);
}
