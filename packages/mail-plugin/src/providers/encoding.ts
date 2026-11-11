/** Portable byte encoding shared by SMTP and SendGrid. @module */

/**
 * Encodes bytes as base64 without a runtime-specific byte buffer.
 * @param bytes - In-memory attachment content
 * @returns Base64 text
 * @since 0.13.0
 */
export function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 32 * 1024)
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 32 * 1024)));
  return btoa(chunks.join(''));
}
