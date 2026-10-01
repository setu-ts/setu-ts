/**
 * Unit — TOTP code generation (RFC 6238): the Appendix B vectors, the counter,
 * and the constant-time compare. Both are the functions `TotpService` runs in
 * production; the ±window is exercised through `TotpService.verify` in
 * `totp-service.test.ts`, so no symbol here is read only by its own test.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { computeTotpCode, constantTimeEquals, totpCounter } from '../../src/mfa/totp-codes.ts';
import { decodeBase32 } from '../../src/mfa/base32.ts';

/**
 * RFC 6238 Appendix B SHA-1 test vectors.
 * The secret is "12345678901234567890" (ASCII), base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
 */
const RFC6238_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/** RFC 6238 Appendix B vectors: [T (seconds), expected 8-digit code]. */
const VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('totp-codes', () => {
  it('computes RFC 6238 Appendix B SHA-1 vectors', async () => {
    const secret = decodeBase32(RFC6238_SECRET);
    const subtle = globalThis.crypto.subtle;
    for (const [timeSec, expected8] of VECTORS) {
      const counter = Math.floor(timeSec / 30);
      const code8 = await computeTotpCode(subtle, secret, counter);
      // RFC vectors are 8-digit; our codes are 6-digit (mod 10^6).
      // The 6-digit code is the last 6 digits of the 8-digit code.
      const expected6 = expected8.slice(-6);
      expect(code8).toBe(expected6);
    }
  });

  it('computes the correct counter for a given time', () => {
    expect(totpCounter(0)).toBe(0);
    expect(totpCounter(29_999)).toBe(0);
    expect(totpCounter(30_000)).toBe(1);
    expect(totpCounter(59_999)).toBe(1);
    expect(totpCounter(60_000)).toBe(2);
  });

  it('constantTimeEquals returns true for identical strings', () => {
    expect(constantTimeEquals('123456', '123456')).toBe(true);
  });

  it('constantTimeEquals returns false for different strings', () => {
    expect(constantTimeEquals('123456', '123457')).toBe(false);
    expect(constantTimeEquals('123456', '654321')).toBe(false);
  });

  it('constantTimeEquals returns false for different lengths', () => {
    expect(constantTimeEquals('12345', '123456')).toBe(false);
    expect(constantTimeEquals('123456', '12345')).toBe(false);
  });

  it('constantTimeEquals refuses a non-string instead of throwing', () => {
    for (const shape of [null, undefined, ['1', '2', '3', '4', '5', '6'], { length: 6 }, 123456]) {
      expect(constantTimeEquals('123456', shape as unknown as string)).toBe(false);
    }
  });
});
