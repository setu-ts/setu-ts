/**
 * Unit — TotpService: enrolment, confirmation, verification, the ±1 step window,
 * replay protection, recovery-code shape, and the completeSignIn /
 * completeSignInWithRecoveryCode paths.
 *
 * The completion paths run against the REAL `AuthSessionService`, because the
 * pending-record TTL it owns is part of what these tests assert — a fake that
 * answers `pending()` and nothing else cannot show that a configured
 * `signIn.mfa.pendingTtlMs` is honoured.
 *
 * Step arithmetic: `confirmEnrolment` claims the step its code was computed for,
 * so a test verifies on a LATER step (`advanceToStep`) rather than the one
 * confirmation spent.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAuthSessionService, IRequestContext } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { TotpService } from '../../src/mfa/totp-service.ts';
import { MemoryTotpStore } from '../../src/stores/totp-store.ts';
import { AuthSessionService } from '../../src/sign-in/auth-session-service.ts';
import { decodeBase32 } from '../../src/mfa/base32.ts';
import { computeTotpCode, TOTP_PERIOD_SECONDS, totpCounter } from '../../src/mfa/totp-codes.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { createFakeSession, createFakeSessionService } from '../fixtures/fake-session.ts';

interface TestContext {
  service: TotpService;
  runtime: ReturnType<typeof createFakeRuntime>;
  store: MemoryTotpStore;
}

function buildService(nowMs: number): TestContext {
  const runtime = createFakeRuntime(nowMs);
  const store = new MemoryTotpStore();
  const service = new TotpService({ store, runtime, issuer: 'TestApp' });
  return { service, runtime, store };
}

/** The wall-clock ms at the start of the given TOTP counter. */
function startOfStep(counter: number): number {
  return counter * TOTP_PERIOD_SECONDS * 1000;
}

/** Moves the controllable clock to the middle of the given TOTP counter. */
function advanceToStep(ctx: TestContext, counter: number): void {
  ctx.runtime.setNow(startOfStep(counter) + 1_000);
}

/** The code `step` produces for `secretText`, independent of the current clock. */
async function codeForSecret(
  ctx: TestContext,
  secretText: string,
  step: number,
): Promise<string> {
  return (await computeTotpCode(ctx.runtime.subtle, decodeBase32(secretText), step)).slice(-6);
}

/** The code for the secret currently stored as active, at `step`. */
async function codeAtStep(ctx: TestContext, principalId: string, step: number): Promise<string> {
  const enrolment = await ctx.store.getEnrolment(principalId);
  if (enrolment === null) throw new Error('not enrolled');
  return codeForSecret(ctx, enrolment.secret, step);
}

/** The code for the current counter. */
function currentCode(ctx: TestContext, principalId: string): Promise<string> {
  return codeAtStep(ctx, principalId, totpCounter(ctx.runtime.now()));
}

/**
 * Enrols and confirms a factor at counter 1, spending that step, and returns
 * the recovery codes confirmation minted.
 */
async function enrolledAndConfirmed(
  ctx: TestContext,
  principalId: string,
): Promise<readonly string[]> {
  await ctx.service.beginEnrolment(principalId, 'alice');
  const code = await currentCode(ctx, principalId);
  const result = await ctx.service.confirmEnrolment(principalId, code);
  if (result.status !== 'ok') throw new Error(`confirmation refused: ${result.status}`);
  return result.recoveryCodes;
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
    expect(result.status).toBe('ok');
    // Confirmation mints the first recovery-code set.
    expect(result.status === 'ok' ? result.recoveryCodes : []).toHaveLength(10);
    const enrolment = await ctx.store.getEnrolment('user1');
    expect(enrolment?.confirmed).toBe(true);
  });

  it('verify returns not-enrolled for an unknown principal', async () => {
    const { service } = buildService(59_000);
    expect(await service.verify('unknown', '123456')).toBe('not-enrolled');
  });

  it('verify returns ok for a valid code on a confirmed factor', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');
    advanceToStep(ctx, 3);
    expect(await ctx.service.verify('user1', await currentCode(ctx, 'user1'))).toBe('ok');
  });

  it('verify returns invalid for a wrong code', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');
    advanceToStep(ctx, 3);
    expect(await ctx.service.verify('user1', '000000')).toBe('invalid');
  });

  it('an unconfirmed enrolment never verifies', async () => {
    const ctx = buildService(59_000);
    await ctx.service.beginEnrolment('user1', 'alice');
    // The code is perfectly correct for the secret that was just generated, and
    // there is still no factor: confirmation is what makes a secret a factor.
    const code = await currentCode(ctx, 'user1');
    expect(await ctx.service.verify('user1', code)).toBe('not-enrolled');
    // confirmEnrolment is the one path that accepts the unconfirmed secret, and
    // that same code confirms it.
    expect((await ctx.service.confirmEnrolment('user1', code)).status).toBe('ok');
  });

  it('a re-enrolment does not destroy the confirmed factor', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1'); // claims counter 1
    advanceToStep(ctx, 3);
    // Spend step 3 under the old secret.
    expect(await ctx.service.verify('user1', await currentCode(ctx, 'user1'))).toBe('ok');

    const oldSecret = (await ctx.store.getEnrolment('user1'))?.secret;
    const { secret: newSecret } = await ctx.service.beginEnrolment('user1', 'alice@new');
    const stored = await ctx.store.getEnrolment('user1');
    expect(stored?.confirmed).toBe(true);
    expect(stored?.secret).toBe(oldSecret);
    expect(stored?.pendingSecret).toBe(newSecret);

    // The OLD secret still verifies (step 4 is in the window and unclaimed).
    expect(await ctx.service.verify('user1', await codeAtStep(ctx, 'user1', 4))).toBe('ok');
    // The NEW secret does not verify while it awaits confirmation.
    expect(await ctx.service.verify('user1', await codeForSecret(ctx, newSecret, 3))).toBe(
      'invalid',
    );

    // Confirmation needs proof of the CURRENT factor; with it, it swaps the
    // pending secret in and keeps the step monotonic.
    advanceToStep(ctx, 5);
    expect(
      (await ctx.service.confirmEnrolment(
        'user1',
        await codeForSecret(ctx, newSecret, 5),
        await codeForSecret(ctx, oldSecret ?? '', 5),
      )).status,
    ).toBe('ok');
    const after = await ctx.store.getEnrolment('user1');
    expect(after?.secret).toBe(newSecret);
    // The pending label becomes the active one; the pending fields are cleared.
    expect(after?.label).toBe('alice@new');
    expect(after?.pendingLabel).toBeUndefined();
    expect(after?.pendingSecret).toBeUndefined();
    expect(after?.lastClaimedStep).toBe(5);
    // A step claimed before the swap is still refused after it.
    expect(await ctx.service.verify('user1', await codeForSecret(ctx, newSecret, 4))).toBe(
      'invalid',
    );
  });

  it('replay of the same step is refused', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');
    advanceToStep(ctx, 3);
    const code = await currentCode(ctx, 'user1');
    // First verification succeeds and claims the step.
    expect(await ctx.service.verify('user1', code)).toBe('ok');
    // Second verification of the same code is refused (replay).
    expect(await ctx.service.verify('user1', code)).toBe('invalid');
  });

  it('an earlier step is refused after a newer one was accepted', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');
    advanceToStep(ctx, 3);
    const code3 = await codeAtStep(ctx, 'user1', 3);
    expect(await ctx.service.verify('user1', code3)).toBe('ok');
    // Advance: step 3 is now earlier than the current one and already claimed.
    advanceToStep(ctx, 4);
    expect(await ctx.service.verify('user1', code3)).toBe('invalid');
  });

  it('the ±1 step window is accepted, two steps out is not', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1'); // claims counter 1
    advanceToStep(ctx, 3);
    // One step before and one step after the current counter are both accepted.
    expect(await ctx.service.verify('user1', await codeAtStep(ctx, 'user1', 2))).toBe('ok');
    expect(await ctx.service.verify('user1', await codeAtStep(ctx, 'user1', 4))).toBe('ok');
    // Two steps after the current counter is never computed.
    expect(await ctx.service.verify('user1', await codeAtStep(ctx, 'user1', 6))).toBe('invalid');
  });

  it('disable removes the enrolment given proof of the factor', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');
    advanceToStep(ctx, 3);
    expect(await ctx.service.disable('user1', await currentCode(ctx, 'user1'))).toBe('ok');
    expect(await ctx.store.getEnrolment('user1')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Proof of the current factor (security audit H1): replacing, regenerating
  // for, or removing a confirmed factor takes the factor.
  // --------------------------------------------------------------------------

  it('a re-enrolment without proof is refused and changes nothing', async () => {
    const ctx = buildService(59_000);
    const codes = await enrolledAndConfirmed(ctx, 'user1');
    const before = await ctx.store.getEnrolment('user1');
    advanceToStep(ctx, 3);
    // The attacker begins an enrolment and confirms their OWN secret.
    const { secret: attacker } = await ctx.service.beginEnrolment('user1', 'mallory');
    const own = await codeForSecret(ctx, attacker, 3);
    expect((await ctx.service.confirmEnrolment('user1', own)).status).toBe('proof-required');
    expect((await ctx.service.confirmEnrolment('user1', own, '000000')).status).toBe('invalid');
    expect((await ctx.service.confirmEnrolment('user1', own, 'AAAAAAAAAAAAAAAA')).status).toBe(
      'invalid',
    );
    // The victim's factor and recovery codes still work.
    const after = await ctx.store.getEnrolment('user1');
    expect(after?.secret).toBe(before?.secret);
    expect(after?.confirmed).toBe(true);
    expect(await ctx.service.verify('user1', await currentCode(ctx, 'user1'))).toBe('ok');
    expect(await ctx.service.verifyRecoveryCode('user1', codes[0])).toBe('ok');
  });

  it('a recovery code proves the current factor for a re-enrolment', async () => {
    const ctx = buildService(59_000);
    const codes = await enrolledAndConfirmed(ctx, 'user1');
    advanceToStep(ctx, 3);
    const { secret } = await ctx.service.beginEnrolment('user1', 'new-device');
    const result = await ctx.service.confirmEnrolment(
      'user1',
      await codeForSecret(ctx, secret, 3),
      codes[0],
    );
    expect(result.status).toBe('ok');
    expect((await ctx.store.getEnrolment('user1'))?.secret).toBe(secret);
    // The swap minted a fresh set: the old set no longer works.
    expect(await ctx.service.verifyRecoveryCode('user1', codes[1])).toBe('invalid');
    const fresh = result.status === 'ok' ? result.recoveryCodes : [];
    expect(await ctx.service.verifyRecoveryCode('user1', fresh[0] ?? '')).toBe('ok');
  });

  it('a re-enrolment with valid proof but a wrong new code is refused', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');
    advanceToStep(ctx, 3);
    const { secret } = await ctx.service.beginEnrolment('user1', 'new-device');
    const result = await ctx.service.confirmEnrolment(
      'user1',
      '000000',
      await currentCode(ctx, 'user1'),
    );
    expect(result.status).toBe('invalid');
    expect((await ctx.store.getEnrolment('user1'))?.pendingSecret).toBe(secret);
  });

  it('a locked account refuses the proof without consulting it', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');
    advanceToStep(ctx, 3);
    for (let i = 0; i < 5; i++) await ctx.service.verify('user1', '000000');
    const { secret } = await ctx.service.beginEnrolment('user1', 'new-device');
    const result = await ctx.service.confirmEnrolment(
      'user1',
      await codeForSecret(ctx, secret, 3),
      await currentCode(ctx, 'user1'),
    );
    expect(result.status).toBe('locked');
    expect((await ctx.service.generateRecoveryCodes('user1', '123456')).status).toBe('locked');
    expect(await ctx.service.disable('user1', '123456')).toBe('locked');
  });

  it('confirmEnrolment answers not-enrolled for an unknown principal', async () => {
    const { service } = buildService(59_000);
    expect((await service.confirmEnrolment('nobody', '123456')).status).toBe('not-enrolled');
  });

  it('generateRecoveryCodes requires proof and replaces the set', async () => {
    const ctx = buildService(59_000);
    const first = await enrolledAndConfirmed(ctx, 'user1');
    expect((await ctx.service.generateRecoveryCodes('user1')).status).toBe('proof-required');
    expect((await ctx.service.generateRecoveryCodes('user1', '000000')).status).toBe('invalid');
    // The first set still works: nothing was regenerated.
    advanceToStep(ctx, 3);
    const result = await ctx.service.generateRecoveryCodes(
      'user1',
      await currentCode(ctx, 'user1'),
    );
    expect(result.status).toBe('ok');
    const second = result.status === 'ok' ? result.recoveryCodes : [];
    expect(second).toHaveLength(10);
    expect(await ctx.service.verifyRecoveryCode('user1', first[0] ?? '')).toBe('invalid');
    expect(await ctx.service.verifyRecoveryCode('user1', second[0] ?? '')).toBe('ok');
  });

  it('generateRecoveryCodes refuses a principal with no confirmed factor', async () => {
    const ctx = buildService(59_000);
    expect((await ctx.service.generateRecoveryCodes('nobody', '123456')).status).toBe(
      'not-enrolled',
    );
    await ctx.service.beginEnrolment('user1', 'alice');
    expect((await ctx.service.generateRecoveryCodes('user1')).status).toBe('not-enrolled');
  });

  it('disable refuses a confirmed factor without valid proof', async () => {
    const ctx = buildService(59_000);
    await enrolledAndConfirmed(ctx, 'user1');
    expect(await ctx.service.disable('user1')).toBe('proof-required');
    expect(await ctx.service.disable('user1', '000000')).toBe('invalid');
    expect((await ctx.store.getEnrolment('user1'))?.confirmed).toBe(true);
  });

  it('disable removes an unconfirmed enrolment without proof, and reports none', async () => {
    const ctx = buildService(59_000);
    expect(await ctx.service.disable('user1')).toBe('not-enrolled');
    await ctx.service.beginEnrolment('user1', 'alice');
    expect(await ctx.service.disable('user1')).toBe('ok');
    expect(await ctx.store.getEnrolment('user1')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // completeSignIn / completeSignInWithRecoveryCode — through the REAL
  // AuthSessionService, whose configured pendingTtlMs governs promotion.
  // --------------------------------------------------------------------------

  interface CompleteHarness extends TestContext {
    authSession: AuthSessionService;
    ctx: IRequestContext;
  }

  function buildCompleteHarness(
    nowMs: number,
    mfa: { readonly required: () => boolean; readonly pendingTtlMs?: number } | undefined,
  ): CompleteHarness {
    const runtime = createFakeRuntime(nowMs);
    const store = new MemoryTotpStore();
    const service = new TotpService({ store, runtime, issuer: 'TestApp' });

    const session = createFakeSession();
    const sessionService = createFakeSessionService(session);
    const authSession = new AuthSessionService({
      sessionService,
      now: () => runtime.now(),
      ...(mfa === undefined ? {} : { mfa }),
    });

    const ctx = {
      id: 'test',
      request: {} as never,
      response: {} as never,
      services: {
        get: (token: string) => {
          if (token === CAPABILITIES.AUTH_SESSION) return authSession;
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

    return { service, runtime, store, authSession, ctx };
  }

  /** Puts the session into the pending state through the real signIn. */
  async function signInAndPend(harness: CompleteHarness): Promise<void> {
    const outcome = await harness.authSession.signIn(
      harness.ctx,
      { id: 'user1', roles: [] },
      { methods: ['pwd'] },
    );
    expect(outcome.status).toBe('second-factor-required');
  }

  it('completeSignIn returns no-pending when there is no pending record', async () => {
    const { service, ctx } = buildCompleteHarness(59_000, undefined);
    expect(await service.completeSignIn(ctx, '123456')).toBe('no-pending');
  });

  it('completeSignIn returns invalid for a wrong code', async () => {
    const harness = buildCompleteHarness(59_000, { required: () => true });
    await enrolledAndConfirmed(harness, 'user1');
    await signInAndPend(harness);
    advanceToStep(harness, 3);
    expect(await harness.service.completeSignIn(harness.ctx, '000000')).toBe('invalid');
  });

  it('completeSignIn returns not-enrolled for an unconfirmed factor', async () => {
    const harness = buildCompleteHarness(59_000, { required: () => true });
    await harness.service.beginEnrolment('user1', 'alice');
    await signInAndPend(harness);
    advanceToStep(harness, 3);
    const code = await currentCode(harness, 'user1');
    expect(await harness.service.completeSignIn(harness.ctx, code)).toBe('not-enrolled');
  });

  it('completeSignIn returns locked when the account is locked out', async () => {
    const harness = buildCompleteHarness(59_000, { required: () => true });
    await enrolledAndConfirmed(harness, 'user1');
    await signInAndPend(harness);
    // Exhaust the lockout: 5 failed attempts.
    for (let i = 0; i < 5; i++) {
      expect(await harness.service.verify('user1', '000000')).toBe('invalid');
    }
    expect(await harness.service.completeSignIn(harness.ctx, '123456')).toBe('locked');
  });

  it('completeSignIn honours the configured signIn.mfa.pendingTtlMs', async () => {
    const harness = buildCompleteHarness(
      startOfStep(1) + 1_000,
      { required: () => true, pendingTtlMs: 1 },
    );
    await enrolledAndConfirmed(harness, 'user1');
    await signInAndPend(harness);
    // Advance past the configured TTL on the same controllable clock the service
    // reads; the code itself is valid for the new step.
    advanceToStep(harness, 3);
    const code = await currentCode(harness, 'user1');
    expect(await harness.service.completeSignIn(harness.ctx, code)).toBe('no-pending');
  });

  it('completeSignIn signs in inside the default TTL (control for the one above)', async () => {
    const harness = buildCompleteHarness(startOfStep(1) + 1_000, { required: () => true });
    await enrolledAndConfirmed(harness, 'user1');
    await signInAndPend(harness);
    advanceToStep(harness, 3);
    const code = await currentCode(harness, 'user1');
    expect(await harness.service.completeSignIn(harness.ctx, code)).toBe('signed-in');
    expect(harness.authSession.current(harness.ctx)?.id).toBe('user1');
  });

  it('completeSignIn refuses to promote through a service with no promotion seam', async () => {
    // A hand-built IAuthSessionService that can report a pending record but has
    // no promotePending: the verifier must refuse rather than promote something
    // the service never agreed to promote.
    const harness = buildCompleteHarness(startOfStep(1) + 1_000, { required: () => true });
    await enrolledAndConfirmed(harness, 'user1');
    advanceToStep(harness, 3);
    const code = await currentCode(harness, 'user1');

    const foreign: IAuthSessionService = {
      signIn: () => Promise.resolve({ status: 'signed-in' }),
      current: () => null,
      pending: () => ({ principal: { id: 'user1' }, methods: ['pwd'], at: harness.runtime.now() }),
      signOut: () => {},
    };
    const ctx = {
      services: {
        get: (token: string) => {
          if (token === CAPABILITIES.AUTH_SESSION) return foreign;
          throw new Error(`unexpected token: ${token}`);
        },
      },
    } as unknown as IRequestContext;

    // The code verifies (the step is claimed), and then promotion is refused.
    expect(await harness.service.completeSignIn(ctx, code)).toBe('no-pending');
  });

  it('completeSignInWithRecoveryCode returns no-pending when there is no pending record', async () => {
    const { service, ctx } = buildCompleteHarness(59_000, undefined);
    expect(await service.completeSignInWithRecoveryCode(ctx, 'ABCDEFGHIJKLMNOP')).toBe(
      'no-pending',
    );
  });

  it('completeSignInWithRecoveryCode returns invalid for an unknown recovery code', async () => {
    const harness = buildCompleteHarness(59_000, { required: () => true });
    await signInAndPend(harness);
    expect(
      await harness.service.completeSignInWithRecoveryCode(harness.ctx, 'ABCDEFGHIJKLMNOP'),
    ).toBe('invalid');
  });

  it('completeSignInWithRecoveryCode returns locked when the account is locked out', async () => {
    const harness = buildCompleteHarness(59_000, { required: () => true });
    await enrolledAndConfirmed(harness, 'user1');
    await signInAndPend(harness);
    // Exhaust the lockout: 5 failed TOTP attempts.
    for (let i = 0; i < 5; i++) {
      await harness.service.verify('user1', '000000');
    }
    expect(
      await harness.service.completeSignInWithRecoveryCode(harness.ctx, 'ABCDEFGHIJKLMNOP'),
    ).toBe('locked');
  });

  it('completeSignInWithRecoveryCode honours the configured pendingTtlMs', async () => {
    const harness = buildCompleteHarness(
      startOfStep(1) + 1_000,
      { required: () => true, pendingTtlMs: 1 },
    );
    const codes = await enrolledAndConfirmed(harness, 'user1');
    await signInAndPend(harness);
    advanceToStep(harness, 3);
    expect(
      await harness.service.completeSignInWithRecoveryCode(harness.ctx, codes[0]),
    ).toBe('no-pending');
  });

  it('completeSignInWithRecoveryCode signs in inside the default TTL (control)', async () => {
    const harness = buildCompleteHarness(startOfStep(1) + 1_000, { required: () => true });
    const codes = await enrolledAndConfirmed(harness, 'user1');
    await signInAndPend(harness);
    expect(
      await harness.service.completeSignInWithRecoveryCode(harness.ctx, codes[0]),
    ).toBe('signed-in');
    expect(harness.authSession.current(harness.ctx)?.id).toBe('user1');
  });
});
