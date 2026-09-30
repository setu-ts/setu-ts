/**
 * Unit — Recovery codes: generation, single-use, digest storage.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TotpService } from '../../src/mfa/totp-service.ts';
import { MemoryTotpStore } from '../../src/stores/totp-store.ts';
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

describe('recovery codes', () => {
  it('generates ten codes of 16 base32 characters', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');

    const codes = await service.generateRecoveryCodes('user1');
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{16}$/);
    }
  });

  it('a recovery code is single-use', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');

    const codes = await service.generateRecoveryCodes('user1');
    // First use succeeds.
    expect(await service.verifyRecoveryCode('user1', codes[0])).toBe('ok');
    // Second use of the same code is refused.
    expect(await service.verifyRecoveryCode('user1', codes[0])).toBe('invalid');
  });

  it('digests are stored, never plaintext', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');

    const codes = await service.generateRecoveryCodes('user1');
    // A plaintext code that was NOT generated should not work.
    expect(await service.verifyRecoveryCode('user1', 'AAAAAAAAAAAAAA==')).toBe('invalid');
    // A generated code works.
    expect(await service.verifyRecoveryCode('user1', codes[1])).toBe('ok');
  });

  it('a wrong recovery code is refused', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');
    await service.generateRecoveryCodes('user1');

    expect(await service.verifyRecoveryCode('user1', 'BBBBBBBBBBBBBBBB')).toBe('invalid');
  });

  it('recovery code lockout works like TOTP lockout', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');
    await service.generateRecoveryCodes('user1');

    // Five wrong recovery codes.
    for (let i = 0; i < 5; i++) {
      expect(await service.verifyRecoveryCode('user1', 'CCCCCCCCCCCCCCCC')).toBe('invalid');
    }
    // Sixth is locked.
    expect(await service.verifyRecoveryCode('user1', 'DDDDDDDDDDDDDDDD')).toBe('locked');
  });

  it('concurrent use of the same recovery code yields exactly one success', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');
    const codes = await service.generateRecoveryCodes('user1');

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
