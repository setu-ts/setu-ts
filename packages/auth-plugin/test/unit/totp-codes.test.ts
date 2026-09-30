/**
 * Unit — TOTP code generation and verification (RFC 6238).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  computeTotpCode,
  constantTimeEquals,
  totpCounter,
  verifyTotpCode,
} from '../../src/mfa/totp-codes.ts';
import { decodeBase32 } from '../../src/mfa/base32.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

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

  it('verifies a code at the current step', async () => {
    const runtime = createFakeRuntime(59_000);
    const secret = decodeBase32(RFC6238_SECRET);
    const code = (await computeTotpCode(runtime.subtle, secret, totpCounter(runtime.now()))).slice(
      -6,
    );
    expect(await verifyTotpCode(runtime, secret, code)).toBe(true);
  });

  it('verifies a code one step before the current step', async () => {
    const runtime = createFakeRuntime(61_000); // counter = 2
    const secret = decodeBase32(RFC6238_SECRET);
    // Code for counter 1 (one step before).
    const code = (await computeTotpCode(runtime.subtle, secret, 1)).slice(-6);
    expect(await verifyTotpCode(runtime, secret, code)).toBe(true);
  });

  it('verifies a code one step after the current step', async () => {
    const runtime = createFakeRuntime(59_000); // counter = 1
    const secret = decodeBase32(RFC6238_SECRET);
    // Code for counter 2 (one step after).
    const code = (await computeTotpCode(runtime.subtle, secret, 2)).slice(-6);
    expect(await verifyTotpCode(runtime, secret, code)).toBe(true);
  });

  it('refuses a code two steps before the current step', async () => {
    const runtime = createFakeRuntime(91_000); // counter = 3
    const secret = decodeBase32(RFC6238_SECRET);
    // Code for counter 1 (two steps before).
    const code = (await computeTotpCode(runtime.subtle, secret, 1)).slice(-6);
    expect(await verifyTotpCode(runtime, secret, code)).toBe(false);
  });

  it('refuses a code two steps after the current step', async () => {
    const runtime = createFakeRuntime(59_000); // counter = 1
    const secret = decodeBase32(RFC6238_SECRET);
    // Code for counter 3 (two steps after).
    const code = (await computeTotpCode(runtime.subtle, secret, 3)).slice(-6);
    expect(await verifyTotpCode(runtime, secret, code)).toBe(false);
  });

  it('refuses a random code', async () => {
    const runtime = createFakeRuntime(59_000);
    const secret = decodeBase32(RFC6238_SECRET);
    expect(await verifyTotpCode(runtime, secret, '000000')).toBe(false);
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
});
