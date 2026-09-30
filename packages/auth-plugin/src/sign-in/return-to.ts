/**
 * The post-sign-in redirect target. Internal: used by the sign-in login route.
 *
 * An open redirect after sign-in is a phishing primitive: the victim's request
 * carries their brand-new session to a host the operator does not control. Only
 * a same-origin absolute path is accepted, and anything else becomes the
 * fallback, so a hostile `?returnTo=` cannot leave the site.
 *
 * @module
 */

/** The longest accepted path in UTF-8 bytes. */
export const MAX_RETURN_TO_BYTES = 512;

/**
 * Returns `value` when it is a safe same-origin path, otherwise `fallback`.
 *
 * Accepted: a single leading `/`, no backslash, no scheme, no control character,
 * and at most {@linkcode MAX_RETURN_TO_BYTES} UTF-8 bytes. Query strings and
 * fragments are allowed, since they stay on this origin.
 *
 * The byte cap exists because the value is stored in the pending entry: on the
 * cookie strategy an unbounded path could push the session past its 4096-byte
 * budget, and the session plugin throws at commit — which would make the login
 * itself fail, not merely drop the redirect.
 *
 * @param value - The caller-supplied target, if any
 * @param fallback - What to use instead when `value` is unsafe; defaults to `/`
 * @returns A same-origin absolute path
 */
export function safeReturnTo(value: string | undefined, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }
  // A single leading slash: `//evil.test` is protocol-relative and leaves the
  // origin, and a value with no leading slash is relative to the callback URL.
  if (!value.startsWith('/') || value.startsWith('//')) {
    return fallback;
  }
  // Browsers treat `\` as `/`, so `/\evil.test` would become `//evil.test`.
  if (value.includes('\\')) {
    return fallback;
  }
  // Control characters can split a header value; 0x7f is included.
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) {
      return fallback;
    }
  }
  if (new TextEncoder().encode(value).byteLength > MAX_RETURN_TO_BYTES) {
    return fallback;
  }
  return value;
}
