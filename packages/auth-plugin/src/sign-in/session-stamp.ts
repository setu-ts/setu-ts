/**
 * The session stamp (M124 §3.3): what `signIn.sessionStamp` returns is recorded
 * at sign-in and compared on every request. Internal: the auth-session service
 * records it and the auth-session strategy compares it; never barrel-exported.
 *
 * Only a SHA-256 digest of the stamp reaches the session. With
 * `SessionPlugin({ mode: 'sign' })` on the cookie strategy the client can read
 * every session value, and an application may use a prefix of its password hash
 * as the stamp.
 *
 * @module
 */

import type { IPrincipal } from '@setu-ts/common';
import type { SessionStamp } from '../interfaces/index.ts';
import { constantTimeEquals } from '../mfa/totp-codes.ts';
import { encodeBase64Url } from '../utils/base64url.ts';

/** The session-stamp reader and the digest primitive it is recorded with. */
export interface SessionStampCheck {
  /** The application's reader (`signIn.sessionStamp`). */
  readonly read: SessionStamp;
  /** Web Crypto, from `runtime.subtle`. */
  readonly subtle: SubtleCrypto;
}

const encoder = new TextEncoder();

/**
 * Reads the principal's current stamp and digests it.
 *
 * @param check - The reader and the digest primitive
 * @param principal - The principal whose stamp is read
 * @returns The base64url SHA-256 digest, or `null` when the reader returned `null`
 * @throws {TypeError} When the reader returns anything other than a string or
 *   `null`; whatever the reader itself throws is propagated
 */
export async function digestSessionStamp(
  check: SessionStampCheck,
  principal: IPrincipal,
): Promise<string | null> {
  const value: unknown = await check.read(principal);
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError(
      `auth-plugin: signIn.sessionStamp must return a string or null, got ${typeof value}`,
    );
  }
  const digest = await check.subtle.digest('SHA-256', encoder.encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * Whether the principal's current stamp matches the one recorded at sign-in.
 *
 * Fails closed: a reader that throws or returns a non-string answers `false`,
 * never the recorded value. Two `null`s match; a `null` and a string do not.
 *
 * @param check - The reader and the digest primitive
 * @param principal - The principal the request resolved
 * @param recorded - The digest the session recorded, or `null`
 * @returns `true` when the stamps match
 */
export async function sessionStampMatches(
  check: SessionStampCheck,
  principal: IPrincipal,
  recorded: string | null,
): Promise<boolean> {
  let current: string | null;
  try {
    current = await digestSessionStamp(check, principal);
  } catch {
    return false;
  }
  if (current === null || recorded === null) {
    return current === recorded;
  }
  return constantTimeEquals(current, recorded);
}
