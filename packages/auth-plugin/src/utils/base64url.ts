/**
 * Base64url encoding/decoding utilities.
 *
 * Base64url uses `-` and `_` instead of `+` and `/`, and omits padding.
 *
 * @module
 */

/**
 * Encode bytes to base64url string (without padding).
 *
 * @param bytes - The bytes to encode
 * @returns Base64url encoded string
 *
 * @example
 * ```typescript
 * encodeBase64Url(new Uint8Array([72, 101, 108, 108, 111])) // 'SGVsbG8'
 * ```
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  const base64 = btoa(binary);
  // Convert to base64url: replace + with -, / with _, and remove padding
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string to bytes.
 *
 * @param input - The base64url string to decode
 * @returns The decoded bytes
 *
 * @example
 * ```typescript
 * decodeBase64Url('SGVsbG8') // Uint8Array([72, 101, 108, 108, 111])
 * ```
 */
export function decodeBase64Url(input: string): Uint8Array {
  // Add padding if needed
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
