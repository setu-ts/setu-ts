/**
 * Pure cookie parse/serialize codec.
 *
 * Lives in `common` because two packages need one implementation and no plugin
 * may import another (AI_GUIDELINES §2.2/§3.3) — the same reasoning that put
 * the realtime frame codec here. The session plugin reads and writes cookies;
 * the decorator plugin's `@Cookie` parameter decorator reads them.
 *
 * Zero dependencies and no runtime APIs, so this is safe on every runtime
 * including Cloudflare Workers.
 *
 * @module
 */

/**
 * Attributes controlling how a browser stores and returns a cookie.
 *
 * Every field is optional, and an omitted field emits no attribute rather than
 * a default. Callers that want a secure cookie must say so: this codec applies
 * no policy of its own, because the session plugin owns those defaults.
 *
 * @since 0.2.0
 */
export interface CookieAttributes {
  /** `Max-Age` in seconds. `0` expires the cookie immediately (deletion). */
  readonly maxAge?: number;
  /** `Path` scope. Conventionally `'/'` for an application-wide cookie. */
  readonly path?: string;
  /** `Domain` scope. Omit for a host-only cookie, which is the safer default. */
  readonly domain?: string;
  /** `Expires` as an absolute date, for clients predating `Max-Age`. */
  readonly expires?: Date;
  /** `HttpOnly` — hides the cookie from `document.cookie`. */
  readonly httpOnly?: boolean;
  /** `Secure` — the cookie is only sent over HTTPS. */
  readonly secure?: boolean;
  /**
   * `SameSite` policy. `'none'` is invalid without `Secure`, so
   * {@linkcode serializeCookie} emits `Secure` alongside it rather than
   * producing a cookie browsers discard.
   */
  readonly sameSite?: 'strict' | 'lax' | 'none';
}

/**
 * Parses a `Cookie` request header into a name→value record.
 *
 * Values are percent-decoded, mirroring {@linkcode serializeCookie}'s encoding
 * so that the two round-trip. A value that is not valid percent-encoding is
 * returned verbatim rather than throwing, because a malformed cookie is a
 * client concern. Pairs without `=` are skipped, and when a name repeats the
 * first occurrence wins — browsers send the most specific cookie first.
 *
 * @param header - The raw `Cookie` header value; `null`/`undefined` when absent
 * @returns Parsed cookies, empty when the header is absent or holds no valid pairs
 * @example
 * ```typescript
 * parseCookie('sid=abc; theme=dark');
 * // → { sid: 'abc', theme: 'dark' }
 * ```
 * @since 0.2.0
 */
export function parseCookie(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === null || header === undefined || header === '') {
    return out;
  }

  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const name = pair.slice(0, idx).trim();
    if (name === '' || Object.hasOwn(out, name)) {
      continue;
    }
    out[name] = decodeCookieValue(stripQuotes(pair.slice(idx + 1).trim()));
  }

  return out;
}

/**
 * Serializes a cookie into a `Set-Cookie` header value.
 *
 * The value is percent-encoded, so a payload containing `;`, `,`, or whitespace
 * can neither inject attributes nor split the header.
 *
 * @param name - Cookie name; must match RFC 6265's `token` production
 * @param value - Cookie value; percent-encoded on the way out
 * @param attrs - Attributes to emit; omitted fields emit no attribute
 * @returns The `Set-Cookie` header value
 * @throws {TypeError} If `name` is not a valid cookie name, or `maxAge` is not an integer
 * @example
 * ```typescript
 * serializeCookie('sid', 'abc', { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 3600 });
 * // → 'sid=abc; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax'
 * ```
 * @since 0.2.0
 */
export function serializeCookie(
  name: string,
  value: string,
  attrs: CookieAttributes = {},
): string {
  if (!COOKIE_NAME.test(name)) {
    throw new TypeError(
      `Invalid cookie name '${name}': must be a non-empty RFC 6265 token ` +
        '(no whitespace, control characters, or any of ()<>@,;:\\"/[]?={})',
    );
  }

  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];

  if (attrs.maxAge !== undefined) {
    if (!Number.isInteger(attrs.maxAge)) {
      throw new TypeError(`Invalid cookie maxAge '${attrs.maxAge}': must be an integer`);
    }
    parts.push(`Max-Age=${attrs.maxAge}`);
  }
  if (attrs.expires !== undefined) {
    parts.push(`Expires=${attrs.expires.toUTCString()}`);
  }
  if (attrs.domain !== undefined) {
    parts.push(`Domain=${attrs.domain}`);
  }
  if (attrs.path !== undefined) {
    parts.push(`Path=${attrs.path}`);
  }
  if (attrs.httpOnly === true) {
    parts.push('HttpOnly');
  }
  // SameSite=None without Secure is rejected by every modern browser, so the
  // attribute is forced rather than emitting a cookie that silently vanishes.
  if (attrs.secure === true || attrs.sameSite === 'none') {
    parts.push('Secure');
  }
  if (attrs.sameSite !== undefined) {
    parts.push(`SameSite=${SAME_SITE_LABEL[attrs.sameSite]}`);
  }

  return parts.join('; ');
}

/** Canonical capitalisation for the `SameSite` attribute value. */
const SAME_SITE_LABEL: Readonly<Record<'strict' | 'lax' | 'none', string>> = {
  strict: 'Strict',
  lax: 'Lax',
  none: 'None',
};

/**
 * RFC 6265 `token` production — the characters a cookie name may contain.
 * Written as an allow-list so control characters are excluded without needing
 * a control-character range in the pattern.
 */
const COOKIE_NAME = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

/** Removes one layer of surrounding double quotes, which RFC 6265 permits. */
function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/**
 * Percent-decodes a cookie value, returning it verbatim when it is not valid
 * percent-encoding. A malformed value is a client concern, not a crash.
 */
function decodeCookieValue(value: string): string {
  if (!value.includes('%')) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
