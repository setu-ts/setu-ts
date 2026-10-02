/**
 * Signature handling for WebAuthn assertions (plan §3.1): ECDSA DER-to-raw
 * conversion and verification over `runtime.subtle`.
 *
 * WebAuthn ES256 signatures are ASN.1 DER (`r` and `s` as INTEGERs), while Web
 * Crypto's ECDSA verify expects the raw `r‖s` form — the conversion is the
 * whole reason this module exists. RS256 and EdDSA signatures arrive in the
 * form Web Crypto expects and pass through unchanged.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import type { PasskeyAlgorithm } from './cose-key.ts';

/** The byte length of a P-256 scalar (`r` or `s`). */
const P256_SCALAR_BYTES = 32;

/** The DER tag for SEQUENCE. */
const DER_SEQUENCE = 0x30;
/** The DER tag for INTEGER. */
const DER_INTEGER = 0x02;

/**
 * Reads one DER length at `offset` (short or long form), refusing a zero or
 * oversized long-form count and an encoding cut off mid-way.
 *
 * Single exit: every malformed shape leaves `result` `null`, so the refusal
 * paths share one return site.
 *
 * @returns The length and the bytes the encoding consumed, or `null` when malformed
 */
function readDerLength(
  bytes: Uint8Array,
  offset: number,
): { length: number; consumed: number } | null {
  const first = bytes[offset];
  let result: { length: number; consumed: number } | null = null;
  if (first !== undefined && first < 0x80) {
    result = { length: first, consumed: 1 };
  } else if (first !== undefined) {
    // Long-form lengths of more than 2 bytes cannot occur in a valid ES256
    // signature and would only serve oversized inputs.
    const count = first & 0x7f;
    if (count >= 1 && count <= 2) {
      let length = 0;
      let complete = true;
      for (let i = 0; i < count; i++) {
        const byte = bytes[offset + 1 + i];
        // A length encoding cut off mid-way is malformed, not truncation to
        // tolerate: the caller's own bounds check refuses the input.
        if (byte === undefined) {
          complete = false;
          break;
        }
        length = length * 256 + byte;
      }
      if (complete) {
        result = { length, consumed: 1 + count };
      }
    }
  }
  return result;
}

/**
 * Reads one DER INTEGER at `offset`, returning its unsigned value bytes
 * (a leading 0x00 added for a positive encoding is stripped) together with
 * the bytes the whole encoding consumed, so the next element's offset can be
 * computed from the encoded form rather than the stripped value.
 *
 * Single exit: every malformed shape leaves `result` `null`.
 *
 * @returns The value bytes and the consumed length, or `null` when malformed
 */
function readDerInteger(
  bytes: Uint8Array,
  offset: number,
): { value: Uint8Array; consumed: number } | null {
  const tag = bytes[offset];
  const length = tag === DER_INTEGER ? readDerLength(bytes, offset + 1) : null;
  const start = length === null ? 0 : offset + 1 + length.consumed;
  const inBounds = length !== null && start + length.length <= bytes.length;
  let value = inBounds ? bytes.slice(start, start + length.length) : new Uint8Array(0);
  // Strip the single leading 0x00 DER adds to keep a positive integer's sign
  // bit clear; more than one would be a non-canonical encoding.
  if (value.length > 1 && value[0] === 0x00) {
    value = value.slice(1);
  }
  // An empty value (a malformed or out-of-bounds encoding) and a scalar
  // longer than a P-256 coordinate are both refusals.
  let result: { value: Uint8Array; consumed: number } | null = null;
  if (
    length !== null && inBounds && value.length >= 1 && value.length <= P256_SCALAR_BYTES
  ) {
    result = { value, consumed: 1 + length.consumed + length.length };
  }
  return result;
}

/**
 * Converts an ASN.1 DER ECDSA signature to the raw `r‖s` form Web Crypto
 * verifies, left-padding each scalar to 32 bytes.
 *
 * Single exit: every malformed shape leaves `raw` `null`.
 *
 * @param der - The DER signature an authenticator produced
 * @returns The 64-byte raw signature, or `null` when the encoding is malformed
 */
export function derToRawSignature(der: Uint8Array): Uint8Array | null {
  const bodyLength = der.length >= 8 && der[0] === DER_SEQUENCE ? readDerLength(der, 1) : null;
  const bodyEnd = bodyLength === null ? 0 : 1 + bodyLength.consumed + bodyLength.length;
  // The body must end exactly at the input: bytes after `s` would be a
  // non-canonical signature, and accepting them would let a tampered
  // signature differ only in trailing data verify.
  const complete = bodyLength !== null && bodyEnd === der.length;
  const rOffset = complete && bodyLength !== null ? 1 + bodyLength.consumed : 0;
  const r = complete ? readDerInteger(der, rOffset) : null;
  const s = r !== null ? readDerInteger(der, rOffset + r.consumed) : null;
  // The two scalars must consume the whole body exactly.
  const consumed = r !== null && s !== null ? rOffset + r.consumed + s.consumed : 0;
  let raw: Uint8Array | null = null;
  if (complete && r !== null && s !== null && consumed === bodyEnd) {
    raw = new Uint8Array(P256_SCALAR_BYTES * 2);
    raw.set(r.value, P256_SCALAR_BYTES - r.value.length);
    raw.set(s.value, P256_SCALAR_BYTES * 2 - s.value.length);
  }
  return raw;
}

/** Concatenates two byte strings. */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Verifies a WebAuthn signature over `data` with the credential's JWK.
 *
 * ES256 signatures must already be in the raw form {@linkcode derToRawSignature}
 * produces; RS256 and EdDSA verify the bytes as they arrived. A platform
 * import or verify failure is a refusal (`false`), never a thrown error — a
 * malformed stored key must not become a 500.
 *
 * @param runtime - Runtime services providing `subtle`
 * @param algorithm - The credential's algorithm
 * @param jwk - The credential's public key
 * @param data - The signed data (`authenticatorData ‖ SHA-256(clientDataJSON)`)
 * @param signature - The signature in Web Crypto's expected form
 * @returns `true` when the signature verifies
 */
export async function verifyPasskeySignature(
  runtime: IRuntimeServices,
  algorithm: PasskeyAlgorithm,
  jwk: JsonWebKey,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await runtime.subtle.importKey(
      'jwk',
      { ...jwk, key_ops: ['verify'], ext: true },
      importAlgorithm(algorithm),
      false,
      ['verify'],
    );
    const params = algorithm === 'ES256'
      ? { name: 'ECDSA', hash: 'SHA-256' }
      : { name: algorithm === 'RS256' ? 'RSASSA-PKCS1-v1_5' : 'Ed25519' };
    return await runtime.subtle.verify(
      params,
      key,
      signature as BufferSource,
      data as BufferSource,
    );
  } catch {
    // A key the runtime refuses (a short RSA modulus, a malformed JWK) is a
    // refusal of the assertion, not a server fault — and importKey rejects
    // just as verify does, so both sit inside the same guard.
    return false;
  }
}

/** The import algorithm for each accepted signature algorithm. */
function importAlgorithm(
  algorithm: PasskeyAlgorithm,
): AlgorithmIdentifier | EcKeyImportParams | RsaHashedImportParams {
  if (algorithm === 'ES256') {
    return { name: 'ECDSA', namedCurve: 'P-256' };
  }
  if (algorithm === 'RS256') {
    return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  }
  return { name: 'Ed25519' };
}
