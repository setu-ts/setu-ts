/**
 * PEM utilities for converting PEM-encoded keys to DER format.
 *
 * @module
 */

/**
 * Convert a PEM-encoded key to DER bytes.
 *
 * @param pem - PEM-encoded key string
 * @param label - Expected label ('PUBLIC KEY' or 'PRIVATE KEY')
 * @returns DER-encoded bytes
 * @throws {Error} If the PEM format is invalid or label doesn't match
 *
 * @example
 * ```typescript
 * const der = pemToDer(pemString, 'PUBLIC KEY');
 * const key = await subtle.importKey('spki', der, ...);
 * ```
 */
export function pemToDer(pem: string, label: 'PUBLIC KEY' | 'PRIVATE KEY'): Uint8Array {
  const lines = pem.replace(/\r\n/g, '\n').split('\n');

  const expectedBegin = `-----BEGIN ${label}-----`;
  const expectedEnd = `-----END ${label}-----`;

  if (lines[0].trim() !== expectedBegin) {
    throw new Error(`PEM must start with "${expectedBegin}"`);
  }

  if (lines[lines.length - 1].trim() !== expectedEnd) {
    throw new Error(`PEM must end with "${expectedEnd}"`);
  }

  // Extract base64 content (lines between header and footer)
  const base64 = lines.slice(1, -1).join('');

  if (!base64.trim()) {
    throw new Error('PEM contains no key data');
  }

  // Standard base64 decode (PEM uses standard base64, not base64url)
  return base64ToBytes(base64);
}

/**
 * Decode standard base64 to bytes.
 *
 * @param base64 - Standard base64 encoded string
 * @returns Decoded bytes
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
