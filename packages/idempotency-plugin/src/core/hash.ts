/**
 * Length-prefixed hashing used by every fingerprint and store-key derivation
 * (plan §3.6, §3.11). One implementation, shared by HTTP and ingress.
 *
 * @module
 */

const encoder = new TextEncoder();

/**
 * Encodes `segments` as `` `${byteLength}:` `` then the segment's UTF-8 bytes,
 * concatenated. Makes segment boundaries part of the hash.
 *
 * @param segments - The ordered segments to encode
 * @returns The concatenated length-prefixed bytes
 */
export function lengthPrefixed(segments: readonly string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const segment of segments) {
    const bytes = encoder.encode(segment);
    const prefix = encoder.encode(`${bytes.byteLength}:`);
    parts.push(prefix, bytes);
    total += prefix.byteLength + bytes.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

/**
 * Hashes the concatenation of `parts` with SHA-256 and returns lower-case hex.
 *
 * @param subtle - The runtime's `SubtleCrypto`
 * @param parts - The byte parts to hash, in order
 * @returns 64 lower-case hex characters
 */
export async function sha256Hex(
  subtle: SubtleCrypto,
  ...parts: Uint8Array[]
): Promise<string> {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  const digest = await subtle.digest('SHA-256', merged);
  return toHex(new Uint8Array(digest));
}

/**
 * Hashes {@linkcode lengthPrefixed}`(segments)` with SHA-256.
 *
 * @param subtle - The runtime's `SubtleCrypto`
 * @param segments - The ordered segments to hash
 * @returns 64 lower-case hex characters
 */
export function deriveHash(subtle: SubtleCrypto, segments: readonly string[]): Promise<string> {
  return sha256Hex(subtle, lengthPrefixed(segments));
}

/** Lower-case hex of a byte array. */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
