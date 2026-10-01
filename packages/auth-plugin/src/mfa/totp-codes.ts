/**
 * TOTP code generation and verification (RFC 6238).
 *
 * HMAC-SHA1 over the 8-byte big-endian Unix-time counter, dynamic truncation,
 * six digits. The current step and one step before and after it are accepted,
 * absorbing 30 s of clock drift in each direction.
 *
 * TOTP counters are Unix-time by definition (RFC 6238 §4), so `runtime.now()`
 * (wall clock) is the correct clock here — not `hrtime()`, which is monotonic
 * and unsuitable for a counter defined on the Unix epoch.
 *
 * @module
 */

import { toBuffer } from '../utils/buffer.ts';

/** TOTP period in seconds (RFC 6238 default). */
export const TOTP_PERIOD_SECONDS = 30;

/** Number of digits in a TOTP code. */
export const TOTP_DIGITS = 6;

/** The ±1 step window accepted around the current counter. */
export const TOTP_WINDOW = 1;

/**
 * Computes the TOTP counter for a given Unix time in milliseconds.
 *
 * TOTP is defined on Unix time (RFC 6238 §4), so the wall clock is the correct
 * source — not `hrtime()`, which is monotonic and has no relation to the epoch.
 *
 * @param nowMs - Wall-clock time in milliseconds since the Unix epoch
 * @returns The 30-second counter
 */
export function totpCounter(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Computes the six-digit TOTP code for a given counter and secret.
 *
 * HMAC-SHA1 over the 8-byte big-endian counter, dynamic truncation per
 * RFC 4226 §5.4, zero-padded to six digits.
 *
 * @param subtle - The Web Crypto `SubtleCrypto` instance
 * @param secret - The base32-decoded secret key
 * @param counter - The 30-second counter
 * @returns The six-digit code as a string
 */
export async function computeTotpCode(
  subtle: SubtleCrypto,
  secret: Uint8Array,
  counter: number,
): Promise<string> {
  const key = await subtle.importKey(
    'raw',
    toBuffer(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  // 8-byte big-endian counter.
  const counterBytes = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const hmac = new Uint8Array(await subtle.sign('HMAC', key, counterBytes));
  // Dynamic truncation (RFC 4226 §5.4).
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 10 ** TOTP_DIGITS;
  return otp.toString().padStart(TOTP_DIGITS, '0');
}

/**
 * Constant-time comparison of two six-character code strings.
 *
 * Compares all characters regardless of where a mismatch occurs, so the
 * timing does not reveal how many leading characters matched.
 *
 * @param a - The first code
 * @param b - The second code
 * @returns `true` when the codes are identical
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
