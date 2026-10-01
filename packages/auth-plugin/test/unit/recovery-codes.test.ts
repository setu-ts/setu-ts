/**
 * Unit — Recovery codes: generation, single-use, digest storage, and the exact
 * canonical shape a code must have before the store is consulted.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TotpService } from '../../src/mfa/totp-service.ts';
import { MemoryTotpStore } from '../../src/stores/totp-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { decodeBase32 } from '../../src/mfa/base32.ts';
import { computeTotpCode, totpCounter } from '../../src/mfa/totp-codes.ts';

interface TestContext {
  service: TotpService;
  runtime: ReturnType<typeof createFakeRuntime>;
  store: MemoryTotpStore;
}

function buildService(nowMs: number): TestContext {
  const runtime = createFakeRuntime(nowMs);
  const store = new MemoryTotpStore();
  const service = new TotpService({ store, runtime, issuer: 'Test' });
  return { service, runtime, store };
}

/**
 * Enrols and confirms `user1`; confirmation is what mints the first recovery-code
 * set, so a principal never holds codes without a proven factor.
 */
async function enrolWithCodes(ctx: TestContext): Promise<readonly string[]> {
  const { secret } = await ctx.service.beginEnrolment('user1', 'alice');
  const code = await computeTotpCode(
    ctx.runtime.subtle,
    decodeBase32(secret),
    totpCounter(ctx.runtime.now()),
  );
  const result = await ctx.service.confirmEnrolment('user1', code);
  if (result.status !== 'ok') throw new Error(`confirmation refused: ${result.status}`);
  return result.recoveryCodes;
}

describe('recovery codes', () => {
  it('confirmation mints ten codes of 16 base32 characters', async () => {
    const ctx = buildService(59_000);
    const codes = await enrolWithCodes(ctx);
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{16}$/);
    }
  });

  it('a recovery code is single-use', async () => {
    const ctx = buildService(59_000);
    const { service } = ctx;

    const codes = await enrolWithCodes(ctx);
    // First use succeeds.
    expect(await service.verifyRecoveryCode('user1', codes[0])).toBe('ok');
    // Second use of the same code is refused.
    expect(await service.verifyRecoveryCode('user1', codes[0])).toBe('invalid');
  });

  it('accepts the generated code in lower case and with surrounding whitespace', async () => {
    const ctx = buildService(59_000);
    const { service } = ctx;
    const codes = await enrolWithCodes(ctx);

    // The documented normalisation: trim, then upper-case.
    expect(await service.verifyRecoveryCode('user1', `  ${codes[0].toLowerCase()}  `)).toBe('ok');
  });

  it('refuses a valid code with an extra character appended', async () => {
    const ctx = buildService(59_000);
    const { service } = ctx;
    const codes = await enrolWithCodes(ctx);

    // decodeBase32 drops leftover bits, so the 17-character string can decode to
    // the same 10 bytes as the code inside it. The length check runs first.
    expect(await service.verifyRecoveryCode('user1', `${codes[0]}A`)).toBe('invalid');
    // And the code is still unconsumed, so it is refused for the right reason:
    // shape, not a spent code.
    expect(await service.verifyRecoveryCode('user1', codes[0])).toBe('ok');
  });

  it('refuses a truncated code and a code with an out-of-alphabet character', async () => {
    const ctx = buildService(59_000);
    const { service } = ctx;
    const codes = await enrolWithCodes(ctx);

    expect(await service.verifyRecoveryCode('user1', codes[0].slice(0, 15))).toBe('invalid');
    expect(await service.verifyRecoveryCode('user1', `${codes[0].slice(0, 15)}1`)).toBe('invalid');
    expect(await service.verifyRecoveryCode('user1', '')).toBe('invalid');
  });

  it('digests are stored, never plaintext', async () => {
    const ctx = buildService(59_000);
    const { service } = ctx;

    const codes = await enrolWithCodes(ctx);
    // A plaintext code that was NOT generated should not work.
    expect(await service.verifyRecoveryCode('user1', 'AAAAAAAAAAAAAAAA')).toBe('invalid');
    // A generated code works.
    expect(await service.verifyRecoveryCode('user1', codes[1])).toBe('ok');
  });

  it('a wrong recovery code is refused', async () => {
    const ctx = buildService(59_000);
    const { service } = ctx;
    await enrolWithCodes(ctx);

    expect(await service.verifyRecoveryCode('user1', 'BBBBBBBBBBBBBBBB')).toBe('invalid');
  });

  it('recovery code lockout works like TOTP lockout', async () => {
    const ctx = buildService(59_000);
    const { service } = ctx;
    await enrolWithCodes(ctx);

    // Five wrong recovery codes.
    for (let i = 0; i < 5; i++) {
      expect(await service.verifyRecoveryCode('user1', 'CCCCCCCCCCCCCCCC')).toBe('invalid');
    }
    // Sixth is locked.
    expect(await service.verifyRecoveryCode('user1', 'DDDDDDDDDDDDDDDD')).toBe('locked');
  });

  it('concurrent use of the same recovery code yields exactly one success', async () => {
    const ctx = buildService(59_000);
    const { service } = ctx;
    const codes = await enrolWithCodes(ctx);

    // Four concurrent uses: within the lockout limit of 5.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => service.verifyRecoveryCode('user1', codes[0])),
    );
    const ok = results.filter((r) => r === 'ok').length;
    const invalid = results.filter((r) => r === 'invalid').length;
    expect(ok).toBe(1);
    expect(invalid).toBe(3);
  });
});
