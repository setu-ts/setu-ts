/**
 * Parsing of the WebAuthn `authenticatorData` byte string (plan §3.2, §3.3):
 * the RP ID hash, the flags, the signature counter, and — on registration —
 * the attested credential data with its COSE public key.
 *
 * @module
 */

import type { CborValue } from './cbor.ts';
import { decodeCborItem } from './cbor.ts';

/** The fixed part: RP ID hash (32) + flags (1) + counter (4). */
const FIXED_BYTES = 37;

/** The AAGUID's length inside attested credential data. */
const AAGUID_BYTES = 16;

/** The credential-id length field's width inside attested credential data. */
const CREDENTIAL_LENGTH_BYTES = 2;

/** The maximum credential id accepted, in bytes (WebAuthn allows 1023). */
const MAX_CREDENTIAL_ID_BYTES = 1023;

/** The parsed fields of one `authenticatorData` byte string. */
export interface AuthenticatorData {
  /** The raw 32-byte RP ID hash; compared against SHA-256 of the RP ID. */
  readonly rpIdHash: Uint8Array;
  /** Flag 0 (UP): the user was present. */
  readonly userPresent: boolean;
  /** Flag 2 (UV): the user was verified (PIN or biometric). */
  readonly userVerified: boolean;
  /** Flag 3 (BE): the key is backed up (synced). Display only (plan §3.3). */
  readonly backedUp: boolean;
  /** Flag 6 (AT): attested credential data is present. */
  readonly attestedCredentialDataIncluded: boolean;
  /** The 32-bit big-endian signature counter. */
  readonly signCounter: number;
  /** The credential id, when AT is set. */
  readonly credentialId?: Uint8Array;
  /** The decoded COSE public key, when AT is set. */
  readonly credentialPublicKey?: CborValue;
}

/**
 * Parses `authenticatorData`, refusing truncated input and an oversized
 * credential id.
 *
 * Extensions (flag 7) are not decoded: no accepted ceremony reads one, and
 * refusing their presence would refuse real authenticators that set the flag
 * for an extension this verifier never asked for. The trailing bytes are
 * ignored, not validated — nothing after the COSE key is trusted.
 *
 * @param bytes - The raw `authenticatorData`
 * @returns The parsed fields, or `null` when the input is malformed
 */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData | null {
  if (bytes.length < FIXED_BYTES) {
    return null;
  }
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32]!;
  const signCounter = (bytes[33]! * 256 + bytes[34]!) * 65536 + bytes[35]! * 256 + bytes[36]!;
  const attestedCredentialDataIncluded = (flags & 0x40) !== 0;
  let credentialId: Uint8Array | undefined;
  let credentialPublicKey: CborValue | undefined;
  if (attestedCredentialDataIncluded) {
    const offset = FIXED_BYTES + AAGUID_BYTES;
    if (bytes.length < offset + CREDENTIAL_LENGTH_BYTES) {
      return null;
    }
    const idLength = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES) {
      return null;
    }
    const idStart = offset + CREDENTIAL_LENGTH_BYTES;
    if (bytes.length < idStart + idLength) {
      return null;
    }
    credentialId = bytes.slice(idStart, idStart + idLength);
    const key = decodeCborItem(bytes, idStart + idLength, 1);
    if (key.ok === false) {
      return null;
    }
    credentialPublicKey = key.value;
  }
  return {
    rpIdHash,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    backedUp: (flags & 0x08) !== 0,
    attestedCredentialDataIncluded,
    signCounter,
    ...(credentialId === undefined ? {} : { credentialId }),
    ...(credentialPublicKey === undefined ? {} : { credentialPublicKey }),
  };
}
