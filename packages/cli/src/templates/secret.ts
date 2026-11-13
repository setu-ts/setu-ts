/** Random values written only to ignored local configuration. @module */

/** Creates a 256-bit secret as 64 lowercase hexadecimal characters. */
export function generateSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
