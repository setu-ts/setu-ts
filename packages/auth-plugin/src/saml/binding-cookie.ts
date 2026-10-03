/**
 * The SAML browser-binding cookie (M100f plan §3.4). Internal.
 *
 * Binds a pending login to the browser that started it. Without it, an
 * attacker could start a login, obtain a valid response for their own
 * account, and make a victim's browser post it to the ACS — the SAML form of
 * login CSRF. `SameSite=None` because the IdP returns by a cross-site `POST`,
 * which a `Lax` cookie does not accompany; `__Host-` pins it to this host,
 * `Secure` and `Path=/`; `HttpOnly` keeps it from script.
 *
 * @module
 */

import type { IRequestContext } from '@setu-ts/common';
import { parseCookie, serializeCookie } from '@setu-ts/common';
import { SAML_PENDING_TTL_MS } from './engine.ts';

/** The cookie name. The `__Host-` prefix makes browsers enforce its attributes. */
export const SAML_BINDING_COOKIE = '__Host-setu-saml';

/** The exact attributes the cookie is set with. */
const ATTRIBUTES = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'none',
} as const;

/** Sets the binding cookie to `value` for the pending lifetime. */
export function setBindingCookie(ctx: IRequestContext, value: string): void {
  ctx.response.appendHeader(
    'Set-Cookie',
    serializeCookie(SAML_BINDING_COOKIE, value, {
      ...ATTRIBUTES,
      maxAge: Math.floor(SAML_PENDING_TTL_MS / 1000),
    }),
  );
}

/** Expires the binding cookie. */
export function clearBindingCookie(ctx: IRequestContext): void {
  ctx.response.appendHeader(
    'Set-Cookie',
    serializeCookie(SAML_BINDING_COOKIE, '', { ...ATTRIBUTES, maxAge: 0 }),
  );
}

/** Reads the binding cookie, or `null` when the browser sent none. */
export function readBindingCookie(ctx: IRequestContext): string | null {
  const value = parseCookie(ctx.request.headers.get('cookie'))[SAML_BINDING_COOKIE];
  return value === undefined || value === '' ? null : value;
}

/**
 * Compares two binding values in time independent of where they first differ.
 *
 * @param a - The presented value
 * @param b - The stored value
 * @returns Whether they are equal
 */
export function bindingMatches(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}
