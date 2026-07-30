/**
 * Cookie envelope encoding — base64url helpers plus the versioned wire format.
 *
 * The envelope is four dot-separated segments: `v1.<kid>.<a>.<b>`, where the
 * meaning of the last two depends on the protection mode:
 *
 * - `'encrypt'` — `<a>` is the AES-GCM IV, `<b>` is ciphertext‖tag.
 *   Web Crypto's `subtle.encrypt` returns the authentication tag appended to
 *   the ciphertext, so unlike `node:crypto` (which exposes it separately via
 *   `getAuthTag()`) there is no fourth tag segment to carry.
 * - `'sign'` — `<a>` is the base64url payload, `<b>` is its HMAC-SHA256.
 *
 * The version comes first and is checked before anything else, so a future
 * format change is a clean rejection rather than a misparse. Every malformed
 * input decodes to `null` rather than throwing: a hostile cookie is routine
 * input, not an exceptional condition.
 *
 * @module
 */

/** The only envelope version this build writes and accepts. */
export const ENVELOPE_VERSION = 'v1';

/** Expected AES-GCM initialization-vector length in bytes. */
export const IV_LENGTH = 12;

/** Number of dot-separated segments in a well-formed envelope. */
const SEGMENT_COUNT = 4;

/**
 * A decoded envelope: the key id that protected it, plus its two payload
 * segments as raw bytes.
 */
export interface DecodedEnvelope {
  /** Key id identifying which key sealed this envelope. */
  readonly kid: string;
  /** AES-GCM IV (`'encrypt'`) or the payload bytes (`'sign'`). */
  readonly first: Uint8Array;
  /** Ciphertext‖tag (`'encrypt'`) or the HMAC (`'sign'`). */
  readonly second: Uint8Array;
}

/**
 * Encodes an envelope.
 *
 * @param kid - Key id of the key that sealed the payload
 * @param first - IV bytes (`'encrypt'`) or payload bytes (`'sign'`)
 * @param second - Ciphertext‖tag (`'encrypt'`) or HMAC bytes (`'sign'`)
 * @returns The dot-separated envelope string
 * @since 0.2.0
 */
export function encodeEnvelope(kid: string, first: Uint8Array, second: Uint8Array): string {
  return [ENVELOPE_VERSION, kid, toBase64Url(first), toBase64Url(second)].join('.');
}

/**
 * Decodes an envelope, returning `null` for any input this build cannot use.
 *
 * Rejects: a segment count other than four, an unrecognised version, an empty
 * key id, invalid base64url in either payload segment, and an empty second
 * segment. When `expectIvLength` is set, a first segment of the wrong length is
 * also rejected — that check belongs to `'encrypt'` mode, where the first
 * segment is a fixed-width IV.
 *
 * @param raw - The raw cookie value
 * @param expectIvLength - Enforce this byte length on the first segment
 * @returns The decoded envelope, or `null` when it is unusable
 * @since 0.2.0
 */
export function decodeEnvelope(
  raw: string,
  expectIvLength?: number,
): DecodedEnvelope | null {
  const parts = raw.split('.');
  if (parts.length !== SEGMENT_COUNT) {
    return null;
  }

  const [version, kid, firstB64, secondB64] = parts;
  if (version !== ENVELOPE_VERSION || kid === '') {
    return null;
  }

  const first = fromBase64Url(firstB64);
  const second = fromBase64Url(secondB64);
  if (first === null || second === null || second.length === 0) {
    return null;
  }
  if (expectIvLength !== undefined && first.length !== expectIvLength) {
    return null;
  }

  return { kid, first, second };
}

/**
 * Encodes bytes as base64url without padding.
 *
 * @param bytes - The bytes to encode
 * @returns Unpadded base64url text
 * @since 0.2.0
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a large payload cannot exceed the argument limit of
  // String.fromCharCode(...spread), which throws on big arrays.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decodes unpadded base64url text, returning `null` when it is not valid.
 *
 * @param text - The base64url text
 * @returns The decoded bytes, or `null` when the input is not valid base64url
 * @since 0.2.0
 */
export function fromBase64Url(text: string): Uint8Array | null {
  if (text === '' || !BASE64URL.test(text)) {
    return null;
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Valid unpadded base64url. Checked before `atob` because `atob` accepts some
 * inputs this format should not (and rejects others by throwing).
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Encodes text as UTF-8 bytes. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Decodes UTF-8 bytes as text. */
export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Copies bytes into a fresh `ArrayBuffer`.
 *
 * Web Crypto's parameters are typed `BufferSource` with an `ArrayBuffer` backing
 * store, while `TextEncoder.encode` returns `Uint8Array<ArrayBufferLike>` — a
 * `SharedArrayBuffer` could back it, so TypeScript rejects the direct pass.
 *
 * This duplicates `auth-plugin`'s internal `toBuffer`, deliberately: that helper
 * is not exported and AI_GUIDELINES §2.2/§3.3 forbid a plugin importing another
 * plugin. Same reasoning as M30b's local `pemToDer` copy.
 *
 * @param bytes - The bytes to copy
 * @returns A new `ArrayBuffer` holding the same bytes
 * @since 0.2.0
 */
export function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
