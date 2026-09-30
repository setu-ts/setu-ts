/**
 * Unit — TotpService lockout: 5 attempts in 15 minutes.
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
  const store = new MemoryTotpStore(runtime);
  const service = new TotpService({ store, runtime, issuer: 'Test' });
  return { service, runtime, store };
}

describe('TotpService lockout', () => {
  it('fifth failure locks the account', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');

    // Five wrong codes.
    for (let i = 0; i < 5; i++) {
      expect(await service.verify('user1', '000000')).toBe('invalid');
    }
    // Sixth attempt is locked.
    expect(await service.verify('user1', '000000')).toBe('locked');
  });

  it('locked state computes no code', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');

    // Lock the account.
    for (let i = 0; i < 5; i++) {
      await service.verify('user1', '000000');
    }
    // Even a valid code is refused while locked.
    expect(await service.verify('user1', '123456')).toBe('locked');
  });

  it('window expiry unlocks the account', async () => {
    const { service, runtime } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');

    // Lock the account.
    for (let i = 0; i < 5; i++) {
      await service.verify('user1', '000000');
    }
    expect(await service.verify('user1', '000000')).toBe('locked');

    // Advance past the 15-minute window.
    runtime.setNow(59_000 + 900_001);
    // Now the account is unlocked again.
    expect(await service.verify('user1', '000000')).toBe('invalid');
  });

  it('success clears the attempt count', async () => {
    const ctx = buildService(59_000);
    await ctx.service.beginEnrolment('user1', 'alice');

    // Three wrong codes.
    for (let i = 0; i < 3; i++) {
      await ctx.service.verify('user1', '000000');
    }

    // A valid code clears the attempts.
    const enrolment = await ctx.store.getEnrolment('user1');
    const secret = decodeBase32(enrolment!.secret);
    const code = (await computeTotpCode(ctx.runtime.subtle, secret, totpCounter(ctx.runtime.now())))
      .slice(-6);
    expect(await ctx.service.verify('user1', code)).toBe('ok');

    // Five more wrong codes should NOT lock (attempts were cleared).
    for (let i = 0; i < 5; i++) {
      expect(await ctx.service.verify('user1', '000000')).toBe('invalid');
    }
    // Sixth is locked.
    expect(await ctx.service.verify('user1', '000000')).toBe('locked');
  });

  it('twenty concurrent wrong codes: exactly five computed, the rest locked', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');

    // All 20 at the same timestamp.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.verify('user1', '000000')),
    );
    const invalid = results.filter((r) => r === 'invalid').length;
    const locked = results.filter((r) => r === 'locked').length;
    expect(invalid).toBe(5);
    expect(locked).toBe(15);
  });
});
