/**
 * Unit — TotpService lockout: 5 attempts in 15 minutes.
 *
 * Every case enrols AND confirms first: an unconfirmed enrolment answers
 * `not-enrolled`, and these tests are about the lockout answers an actual
 * factor produces.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TotpService } from '../../src/mfa/totp-service.ts';
import { MemoryTotpStore } from '../../src/stores/totp-store.ts';
import { decodeBase32 } from '../../src/mfa/base32.ts';
import { computeTotpCode, totpCounter } from '../../src/mfa/totp-codes.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

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

/** The current 6-digit code for the principal's active secret. */
async function currentCode(ctx: TestContext, principalId: string): Promise<string> {
  const enrolment = await ctx.store.getEnrolment(principalId);
  if (enrolment === null) throw new Error('not enrolled');
  const secret = decodeBase32(enrolment.secret);
  return (await computeTotpCode(ctx.runtime.subtle, secret, totpCounter(ctx.runtime.now())))
    .slice(-6);
}

/** Enrols and confirms, so `verify` answers as a real factor does. */
async function enrolledAndConfirmed(ctx: TestContext, principalId: string): Promise<void> {
  await ctx.service.beginEnrolment(principalId, 'alice');
  expect(await ctx.service.confirmEnrolment(principalId, await currentCode(ctx, principalId)))
    .toBe('ok');
}

describe('TotpService lockout', () => {
  it('fifth failure locks the account', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');

    // Five wrong codes.
    for (let i = 0; i < 5; i++) {
      expect(await ctx.service.verify('user1', '000000')).toBe('invalid');
    }
    // Sixth attempt is locked.
    expect(await ctx.service.verify('user1', '000000')).toBe('locked');
  });

  it('locked state computes no code', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');

    // Lock the account.
    for (let i = 0; i < 5; i++) {
      await ctx.service.verify('user1', '000000');
    }
    // Even a valid code is refused while locked.
    expect(await ctx.service.verify('user1', await currentCode(ctx, 'user1'))).toBe('locked');
  });

  it('window expiry unlocks the account', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');

    // Lock the account.
    for (let i = 0; i < 5; i++) {
      await ctx.service.verify('user1', '000000');
    }
    expect(await ctx.service.verify('user1', '000000')).toBe('locked');

    // Advance past the 15-minute window.
    ctx.runtime.setNow(59_000 + 900_001);
    // Now the account is unlocked again.
    expect(await ctx.service.verify('user1', '000000')).toBe('invalid');
  });

  it('success clears the attempt count', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');

    // Three wrong codes.
    for (let i = 0; i < 3; i++) {
      await ctx.service.verify('user1', '000000');
    }

    // A valid code clears the attempts. The code is for a step ahead of the one
    // confirmation claimed, so the claim succeeds.
    ctx.runtime.setNow(59_000 + 2 * 30_000);
    expect(await ctx.service.verify('user1', await currentCode(ctx, 'user1'))).toBe('ok');

    // Five more wrong codes should NOT lock (attempts were cleared).
    for (let i = 0; i < 5; i++) {
      expect(await ctx.service.verify('user1', '000000')).toBe('invalid');
    }
    // Sixth is locked.
    expect(await ctx.service.verify('user1', '000000')).toBe('locked');
  });

  it('twenty concurrent wrong codes: exactly five computed, the rest locked', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');

    // All 20 at the same timestamp.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ctx.service.verify('user1', '000000')),
    );
    const invalid = results.filter((r) => r === 'invalid').length;
    const locked = results.filter((r) => r === 'locked').length;
    expect(invalid).toBe(5);
    expect(locked).toBe(15);
  });
});
