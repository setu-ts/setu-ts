/**
 * Cryptographically random lower-case hex, shared by the observed fetch's
 * plugin nonce and the idempotency-key generator (M109b §3.8, §11.1).
 *
 * @internal
 * @module
 */

/**
 * Draws `byteLength` random bytes through `crypto.getRandomValues` and returns
 * them as lower-case hex.
 *
 * @param byteLength - The number of random bytes to draw
 * @param unavailableMessage - The message of the `TypeError` thrown when
 *   `crypto.getRandomValues` is unavailable
 * @returns `byteLength * 2` lower-case hex characters
 * @throws {TypeError} When `crypto.getRandomValues` is unavailable
 */
export function drawHexBytes(byteLength: number, unavailableMessage: string): string {
  const crypto = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new TypeError(unavailableMessage);
  }
  const bytes = new Uint8Array(byteLength);
  (crypto as { getRandomValues(array: Uint8Array): Uint8Array }).getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
