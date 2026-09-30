/**
 * Unit — MemoryTotpStore: concurrent claimStep, reserveAttempt, consumeRecoveryCode.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryTotpStore } from '../../src/stores/totp-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('MemoryTotpStore', () => {
  it('concurrent claimStep yields exactly one success', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);
    await store.saveEnrolment('user1', {
      secret: 'TESTSECRET',
      label: 'test',
      confirmed: true,
      lastClaimedStep: 0,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.claimStep('user1', 5)),
    );
    const successes = results.filter((r) => r === true).length;
    expect(successes).toBe(1);
  });

  it('claimStep refuses a step at or below the last claimed', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);
    await store.saveEnrolment('user1', {
      secret: 'TESTSECRET',
      label: 'test',
      confirmed: true,
      lastClaimedStep: 5,
    });

    expect(await store.claimStep('user1', 5)).toBe(false);
    expect(await store.claimStep('user1', 4)).toBe(false);
    expect(await store.claimStep('user1', 3)).toBe(false);
    expect(await store.claimStep('user1', 6)).toBe(true);
  });

  it('claimStep returns false for an unknown principal', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);
    expect(await store.claimStep('unknown', 5)).toBe(false);
  });

  it('concurrent reserveAttempt counts correctly', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);

    const results = await Promise.all(
      Array.from(
        { length: 10 },
        () => store.reserveAttempt('user1', 59_000, { limit: 5, windowMs: 900_000 }),
      ),
    );
    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(5);
    expect(denied).toBe(5);
  });

  it('reserveAttempt evicts old timestamps outside the window', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);

    // Five attempts at t=0.
    for (let i = 0; i < 5; i++) {
      await store.reserveAttempt('user1', 0, { limit: 5, windowMs: 900_000 });
    }
    // At t=900_001, all old attempts are evicted.
    const result = await store.reserveAttempt('user1', 900_001, {
      limit: 5,
      windowMs: 900_000,
    });
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });

  it('clearAttempts removes the count', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);

    for (let i = 0; i < 5; i++) {
      await store.reserveAttempt('user1', 59_000, { limit: 5, windowMs: 900_000 });
    }
    await store.clearAttempts('user1');
    const result = await store.reserveAttempt('user1', 59_000, {
      limit: 5,
      windowMs: 900_000,
    });
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });

  it('concurrent consumeRecoveryCode yields exactly one success', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);
    await store.saveRecoveryCodes('user1', ['digest-a', 'digest-b', 'digest-c']);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.consumeRecoveryCode('user1', 'digest-a')),
    );
    const successes = results.filter((r) => r === true).length;
    expect(successes).toBe(1);
  });

  it('consumeRecoveryCode returns false for an unknown digest', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);
    await store.saveRecoveryCodes('user1', ['digest-a']);
    expect(await store.consumeRecoveryCode('user1', 'digest-z')).toBe(false);
  });

  it('consumeRecoveryCode returns false for an unknown principal', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);
    expect(await store.consumeRecoveryCode('unknown', 'digest-a')).toBe(false);
  });

  it('deleteEnrolment removes enrolment, attempts, and recovery codes', async () => {
    const runtime = createFakeRuntime(59_000);
    const store = new MemoryTotpStore(runtime);
    await store.saveEnrolment('user1', {
      secret: 'TESTSECRET',
      label: 'test',
      confirmed: true,
      lastClaimedStep: 0,
    });
    await store.saveRecoveryCodes('user1', ['digest-a']);
    await store.reserveAttempt('user1', 59_000, { limit: 5, windowMs: 900_000 });

    await store.deleteEnrolment('user1');

    expect(await store.getEnrolment('user1')).toBeNull();
    expect(await store.consumeRecoveryCode('user1', 'digest-a')).toBe(false);
    const result = await store.reserveAttempt('user1', 59_000, {
      limit: 5,
      windowMs: 900_000,
    });
    expect(result.count).toBe(1);
  });
});
