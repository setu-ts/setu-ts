/**
 * PEM decoding for the FCM service-account signing key.
 *
 * `auth-plugin` carries an equivalent helper, but it is internal to that
 * package and a plugin may not import another plugin (AI_GUIDELINES §2.2,
 * §3.3), so this is a deliberate local copy rather than shared code. If a third
 * consumer appears, promoting it to `@hono-enterprise/common` becomes the right
 * call.
 *
 * @module
 */

/**
 * Converts a PEM-encoded key to DER bytes.
 *
 * Tolerates CRLF line endings and surrounding blank lines, both of which appear
 * in service-account keys that have been round-tripped through JSON or an
 * environment variable.
 *
 * @param pem - PEM-encoded key string
 * @param label - Expected PEM label
 * @returns DER-encoded bytes, ready for `subtle.importKey('pkcs8', …)`
 * @throws {Error} If the header or footer is missing, or the body is empty
 * @example
 * ```typescript
 * const der = pemToDer(serviceAccount.private_key, 'PRIVATE KEY');
 * const key = await subtle.importKey('pkcs8', der, algorithm, false, ['sign']);
 * ```
 * @since 0.1.0
 */
export function pemToDer(pem: string, label: 'PRIVATE KEY'): Uint8Array {
  const lines = pem
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const expectedBegin = `-----BEGIN ${label}-----`;
  const expectedEnd = `-----END ${label}-----`;

  if (lines[0] !== expectedBegin) {
    throw new Error(`PEM must start with "${expectedBegin}"`);
  }
  if (lines[lines.length - 1] !== expectedEnd) {
    throw new Error(`PEM must end with "${expectedEnd}"`);
  }

  const base64 = lines.slice(1, -1).join('');
  if (!base64.trim()) {
    throw new Error('PEM contains no key data');
  }

  // PEM bodies are standard base64, not base64url.
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
