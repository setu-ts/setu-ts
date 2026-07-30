/**
 * Constant-time comparison.
 *
 * Web Crypto exposes no `timingSafeEqual` (that is a `node:crypto` API, which
 * is unavailable outside `packages/runtime`), so the comparison is implemented
 * here over `Uint8Array`.
 *
 * @module
 */

/**
 * Compares two byte arrays without leaking their first differing index through
 * timing.
 *
 * The loop always runs over the full length and accumulates differences with a
 * bitwise OR instead of returning early, so the duration depends only on the
 * length. Lengths are compared first, which does leak length — unavoidable, and
 * harmless here because both inputs are fixed-width tokens.
 *
 * @param a - First byte array
 * @param b - Second byte array
 * @returns `true` when both arrays have the same length and contents
 * @since 0.2.0
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Compares two strings in constant time by encoding them to UTF-8 first.
 *
 * @param a - First string
 * @param b - Second string
 * @returns `true` when the strings are byte-identical
 * @since 0.2.0
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return timingSafeEqualBytes(encoder.encode(a), encoder.encode(b));
}
