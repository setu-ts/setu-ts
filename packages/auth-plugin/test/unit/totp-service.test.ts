/**
 * Unit — TotpService: enrolment, verification, replay protection,
 * and the completeSignIn / completeSignInWithRecoveryCode paths.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAuthSessionService, IRequestContext, PendingSignIn } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { TotpService } from '../../src/mfa/totp-service.ts';
import { MemoryTotpStore } from '../../src/stores/totp-store.ts';
import { decodeBase32 } from '../../src/mfa/base32.ts';
import { computeTotpCode, totpCounter } from '../../src/mfa/totp-codes.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { createFakeSession, createFakeSessionService } from '../fixtures/fake-session.ts';

interface TestContext {
  service: TotpService;
  runtime: ReturnType<typeof createFakeRuntime>;
  store: MemoryTotpStore;
}

function buildService(nowMs: number): TestContext {
  const runtime = createFakeRuntime(nowMs);
  const store = new MemoryTotpStore(runtime);
  const service = new TotpService({ store, runtime, issuer: 'TestApp' });
  return { service, runtime, store };
}

/** Computes the current 6-digit TOTP code for a principal using the shared store. */
async function currentCode(ctx: TestContext, principalId: string): Promise<string> {
  const enrolment = await ctx.store.getEnrolment(principalId);
  if (enrolment === null) throw new Error('not enrolled');
  const secret = decodeBase32(enrolment.secret);
  const code8 = await computeTotpCode(ctx.runtime.subtle, secret, totpCounter(ctx.runtime.now()));
  return code8.slice(-6);
}

describe('TotpService', () => {
  it('beginEnrolment produces a valid otpauth:// URI', async () => {
    const { service } = buildService(59_000);
    const { secret, uri } = await service.beginEnrolment('user1', 'alice@example.com');
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('TestApp:alice%40example.com');
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=TestApp');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('confirmEnrolment confirms with a valid code', async () => {
    const ctx = buildService(59_000);
    await ctx.service.beginEnrolment('user1', 'alice');
    const code = await currentCode(ctx, 'user1');
    const result = await ctx.service.confirmEnrolment('user1', code);
    expect(result).toBe('ok');
    const enrolment = await ctx.store.getEnrolment('user1');
    expect(enrolment?.confirmed).toBe(true);
  });

  it('verify returns not-enrolled for an unknown principal', async () => {
    const { service } = buildService(59_000);
    const result = await service.verify('unknown', '123456');
    expect(result).toBe('not-enrolled');
  });

  it('verify returns ok for a valid code', async () => {
    const ctx = buildService(59_000);
    await ctx.service.beginEnrolment('user1', 'alice');
    const code = await currentCode(ctx, 'user1');
    const result = await ctx.service.verify('user1', code);
    expect(result).toBe('ok');
  });

  it('verify returns invalid for a wrong code', async () => {
    const { service } = buildService(59_000);
    await service.beginEnrolment('user1', 'alice');
    const result = await service.verify('user1', '000000');
    expect(result).toBe('invalid');
  });

  it('replay of the same step is refused', async () => {
    const ctx = buildService(59_000);
    await ctx.service.beginEnrolment('user1', 'alice');
    const code = await currentCode(ctx, 'user1');
    // First verification succeeds and claims the step.
    expect(await ctx.service.verify('user1', code)).toBe('ok');
    // Second verification of the same code is refused (replay).
    expect(await ctx.service.verify('user1', code)).toBe('invalid');
  });

  it('an earlier step is refused after a newer one was accepted', async () => {
    const ctx = buildService(59_000); // counter = 1
    await ctx.service.beginEnrolment('user1', 'alice');
    // Verify the code for counter 1 (current).
    const code1 = await currentCode(ctx, 'user1');
    expect(await ctx.service.verify('user1', code1)).toBe('ok');
    // Now advance to counter 2.
    ctx.runtime.setNow(91_000);
    // The code for counter 1 should now be refused (earlier step).
    const enrolment = await ctx.store.getEnrolment('user1');
    const secret = decodeBase32(enrolment!.secret);
    const oldCode = (await computeTotpCode(ctx.runtime.subtle, secret, 1)).slice(-6);
    expect(await ctx.service.verify('user1', oldCode)).toBe('invalid');
  });

  it('disable removes the enrolment', async () => {
    const ctx = buildService(59_000);
    await ctx.service.beginEnrolment('user1', 'alice');
    await ctx.service.disable('user1');
    expect(await ctx.store.getEnrolment('user1')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // completeSignIn / completeSignInWithRecoveryCode — unit-level branch
  // coverage through a fake request context.
  // -----------------------------------------------------------------------

  function buildCompleteSignInHarness(
    nowMs: number,
    pending: PendingSignIn | null,
  ): {
    service: TotpService;
    runtime: ReturnType<typeof createFakeRuntime>;
    store: MemoryTotpStore;
    ctx: IRequestContext;
  } {
    const runtime = createFakeRuntime(nowMs);
    const store = new MemoryTotpStore(runtime);
    const service = new TotpService({ store, runtime, issuer: 'TestApp' });

    const session = createFakeSession();
    const sessionService = createFakeSessionService(session);

    const authSessionService: IAuthSessionService = {
      signIn: () => Promise.resolve({ status: 'signed-in' }),
      current: () => null,
      pending: () => pending,
      signOut: () => {},
    };

    const ctx = {
      id: 'test',
      request: {} as never,
      response: {} as never,
      services: {
        get: (token: string) => {
          if (token === CAPABILITIES.AUTH_SESSION) return authSessionService;
          if (token === CAPABILITIES.SESSION) return sessionService;
          throw new Error(`unexpected token: ${token}`);
        },
        has: (token: string) =>
          token === CAPABILITIES.AUTH_SESSION || token === CAPABILITIES.SESSION,
        register: () => {},
        registerScoped: () => {},
        getScoped: () => null,
      },
      params: {},
      query: {},
      state: new Map(),
      startTime: nowMs,
      signal: new AbortController().signal,
    } as unknown as IRequestContext;

    return { service, runtime, store, ctx };
  }

  it('completeSignIn returns no-pending when there is no pending record', async () => {
    const { service, ctx } = buildCompleteSignInHarness(59_000, null);
    const result = await service.completeSignIn(ctx, '123456');
    expect(result).toBe('no-pending');
  });

  it('completeSignIn returns invalid for a wrong code', async () => {
    const pending: PendingSignIn = { principal: { id: 'user1' }, methods: ['pwd'], at: 59_000 };
    const harness = buildCompleteSignInHarness(59_000, pending);
    await harness.service.beginEnrolment('user1', 'alice');
    const result = await harness.service.completeSignIn(harness.ctx, '000000');
    expect(result).toBe('invalid');
  });

  it('completeSignIn returns locked when the account is locked out', async () => {
    const pending: PendingSignIn = { principal: { id: 'user1' }, methods: ['pwd'], at: 59_000 };
    const harness = buildCompleteSignInHarness(59_000, pending);
    await harness.service.beginEnrolment('user1', 'alice');
    // Exhaust the lockout: 5 failed attempts.
    for (let i = 0; i < 5; i++) {
      await harness.service.verify('user1', '000000');
    }
    const result = await harness.service.completeSignIn(harness.ctx, '123456');
    expect(result).toBe('locked');
  });

  it('completeSignInWithRecoveryCode returns no-pending when there is no pending record', async () => {
    const { service, ctx } = buildCompleteSignInHarness(59_000, null);
    const result = await service.completeSignInWithRecoveryCode(ctx, 'ABCDEFGHIJKLMNOP');
    expect(result).toBe('no-pending');
  });

  it('completeSignInWithRecoveryCode returns invalid for an unknown recovery code', async () => {
    const pending: PendingSignIn = { principal: { id: 'user1' }, methods: ['pwd'], at: 59_000 };
    const harness = buildCompleteSignInHarness(59_000, pending);
    // No recovery codes have been generated, so any code is invalid.
    const result = await harness.service.completeSignInWithRecoveryCode(
      harness.ctx,
      'ABCDEFGHIJKLMNOP',
    );
    expect(result).toBe('invalid');
  });

  it('completeSignInWithRecoveryCode returns locked when the account is locked out', async () => {
    const pending: PendingSignIn = { principal: { id: 'user1' }, methods: ['pwd'], at: 59_000 };
    const harness = buildCompleteSignInHarness(59_000, pending);
    await harness.service.beginEnrolment('user1', 'alice');
    // Exhaust the lockout: 5 failed TOTP attempts.
    for (let i = 0; i < 5; i++) {
      await harness.service.verify('user1', '000000');
    }
    const result = await harness.service.completeSignInWithRecoveryCode(
      harness.ctx,
      'ABCDEFGHIJKLMNOP',
    );
    expect(result).toBe('locked');
  });
});
