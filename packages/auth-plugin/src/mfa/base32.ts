/**
 * RFC 4648 base32 codec (no padding).
 *
 * Used for TOTP secrets and recovery codes. The alphabet is the standard
 * `A-Z2-7` from RFC 4648 §6.
 *
 * @module
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const DECODE_TABLE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE_TABLE[ALPHABET[i]] = i;
}

/**
 * Encodes a byte array to a base32 string (RFC 4648, no padding).
 *
 * @param bytes - The bytes to encode
 * @returns The base32 string
 */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decodes a base32 string (RFC 4648, no padding) to a byte array.
 *
 * Accepts uppercase and lowercase input; whitespace is ignored.
 *
 * @param text - The base32 string to decode
 * @returns The decoded bytes
 * @throws {Error} If the input contains characters outside the base32 alphabet
 */
export function decodeBase32(text: string): Uint8Array {
  const cleaned = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const decoded = DECODE_TABLE[char];
    if (decoded === undefined) {
      throw new Error(`Invalid base32 character: '${char}'`);
    }
    value = (value << 5) | decoded;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}
