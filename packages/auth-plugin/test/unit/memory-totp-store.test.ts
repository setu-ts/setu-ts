/**
 * Unit — MemoryTotpStore: concurrent claimStep, reserveAttempt,
 * consumeRecoveryCode, and the pending-secret round-trip a safe re-enrolment
 * depends on.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryTotpStore, sweepExpiredAttempts } from '../../src/stores/totp-store.ts';

/** A store holding a CONFIRMED factor whose last claimed step is `step`. */
async function confirmedStore(step = 0): Promise<MemoryTotpStore> {
  const store = new MemoryTotpStore();
  await store.stageSecret('user1', 'TESTSECRET', 'test');
  expect(await store.confirmSecret('user1', 'TESTSECRET', step)).toBe(true);
  return store;
}

describe('MemoryTotpStore', () => {
  it('concurrent claimStep yields exactly one success', async () => {
    const store = await confirmedStore();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.claimStep('user1', 5)),
    );
    const successes = results.filter((r) => r === true).length;
    expect(successes).toBe(1);
  });

  it('claimStep refuses a step at or below the last claimed', async () => {
    const store = await confirmedStore(5);

    expect(await store.claimStep('user1', 5)).toBe(false);
    expect(await store.claimStep('user1', 4)).toBe(false);
    expect(await store.claimStep('user1', 3)).toBe(false);
    expect(await store.claimStep('user1', 6)).toBe(true);
  });

  it('claimStep returns false for an unknown principal', async () => {
    const store = new MemoryTotpStore();
    expect(await store.claimStep('unknown', 5)).toBe(false);
  });

  it('stageSecret on a confirmed factor sets the pending secret and touches nothing else', async () => {
    const store = new MemoryTotpStore();
    await store.stageSecret('user1', 'OLDCONFIRMED', 'alice@old');
    await store.confirmSecret('user1', 'OLDCONFIRMED', 7);
    await store.stageSecret('user1', 'NEWUNCONFIRMED', 'alice@new');

    expect(await store.getEnrolment('user1')).toEqual({
      secret: 'OLDCONFIRMED',
      label: 'alice@old',
      confirmed: true,
      lastClaimedStep: 7,
      pendingSecret: 'NEWUNCONFIRMED',
      pendingLabel: 'alice@new',
    });
    // The old secret's claimed step is still refused.
    expect(await store.claimStep('user1', 7)).toBe(false);
  });

  it('stageSecret creates, then replaces, an unconfirmed enrolment keeping its step', async () => {
    const store = new MemoryTotpStore();
    await store.stageSecret('user1', 'AAA', 'a');
    expect(await store.getEnrolment('user1')).toEqual({
      secret: 'AAA',
      label: 'a',
      confirmed: false,
      lastClaimedStep: 0,
    });
    expect(await store.claimStep('user1', 9)).toBe(true);
    await store.stageSecret('user1', 'BBB', 'b');
    expect(await store.getEnrolment('user1')).toEqual({
      secret: 'BBB',
      label: 'b',
      confirmed: false,
      lastClaimedStep: 9,
    });
  });

  it('stageSecret never rolls back a step claimed between a read and the write (M1)', async () => {
    // The race a whole-record write-back loses: a step is claimed after the
    // service's read but before its write. stageSecret has no read to be stale.
    const store = await confirmedStore(3);
    expect(await store.claimStep('user1', 4)).toBe(true);
    await store.stageSecret('user1', 'NEWSECRET', 'new');
    expect((await store.getEnrolment('user1'))?.lastClaimedStep).toBe(4);
    expect(await store.claimStep('user1', 4)).toBe(false);
  });

  it('confirmSecret confirms only the secret still awaiting confirmation', async () => {
    const store = new MemoryTotpStore();
    expect(await store.confirmSecret('nobody', 'X', 1)).toBe(false);

    // First enrolment: a secret staged after the one checked wins nothing.
    await store.stageSecret('user1', 'VICTIM', 'v');
    await store.stageSecret('user1', 'ATTACKER', 'a');
    expect(await store.confirmSecret('user1', 'VICTIM', 2)).toBe(false);
    expect((await store.getEnrolment('user1'))?.confirmed).toBe(false);
    expect(await store.confirmSecret('user1', 'ATTACKER', 2)).toBe(true);

    // Re-enrolment: the pending secret is swapped in, the step only rises.
    await store.stageSecret('user1', 'NEXT', 'next');
    expect(await store.confirmSecret('user1', 'ATTACKER', 9)).toBe(false);
    expect(await store.confirmSecret('user1', 'NEXT', 1)).toBe(true);
    expect(await store.getEnrolment('user1')).toEqual({
      secret: 'NEXT',
      label: 'next',
      confirmed: true,
      lastClaimedStep: 2,
    });
    // A confirmed factor with nothing pending has nothing awaiting.
    expect(await store.confirmSecret('user1', 'NEXT', 5)).toBe(false);
  });

  it('concurrent reserveAttempt counts correctly', async () => {
    const store = new MemoryTotpStore();

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
    const store = new MemoryTotpStore();

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
    const store = new MemoryTotpStore();

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
    const store = new MemoryTotpStore();
    await store.saveRecoveryCodes('user1', ['digest-a', 'digest-b', 'digest-c']);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.consumeRecoveryCode('user1', 'digest-a')),
    );
    const successes = results.filter((r) => r === true).length;
    expect(successes).toBe(1);
  });

  it('consumeRecoveryCode returns false for an unknown digest', async () => {
    const store = new MemoryTotpStore();
    await store.saveRecoveryCodes('user1', ['digest-a']);
    expect(await store.consumeRecoveryCode('user1', 'digest-z')).toBe(false);
  });

  it('consumeRecoveryCode returns false for an unknown principal', async () => {
    const store = new MemoryTotpStore();
    expect(await store.consumeRecoveryCode('unknown', 'digest-a')).toBe(false);
  });

  it('deleteEnrolment removes enrolment, attempts, and recovery codes', async () => {
    const store = await confirmedStore();
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

  it('a refused attempt is not recorded, so continued guessing cannot extend the lock', async () => {
    const store = new MemoryTotpStore();
    const window = { limit: 5, windowMs: 900_000 };
    for (let i = 0; i < 5; i++) {
      expect((await store.reserveAttempt('user1', i, window)).allowed).toBe(true);
    }
    // An attacker keeps guessing for the whole window.
    for (let t = 5; t < 900_004; t += 1_000) {
      const refused = await store.reserveAttempt('user1', t, window);
      expect(refused).toEqual({ allowed: false, count: 6 });
    }
    // The window measured from the fifth counted attempt has passed: unlocked.
    expect(await store.reserveAttempt('user1', 900_005, window)).toEqual({
      allowed: true,
      count: 1,
    });
  });

  it('a principal whose first attempt triggers a sweep is still counted', async () => {
    const store = new MemoryTotpStore();
    const window = { limit: 5, windowMs: 1_000 };
    // One short of the initial sweep threshold (1 024) of expired entries, so a
    // NEW principal's entry is the one that reaches it. Sweeping after that entry
    // is created would delete it (an empty entry counts as expired) and count
    // into a detached object, so the next attempt would start again at 1.
    for (let i = 0; i < 1_023; i++) await store.reserveAttempt(`old-${i}`, 0, window);
    expect(await store.reserveAttempt('fresh', 10_000, window)).toEqual({
      allowed: true,
      count: 1,
    });
    expect(await store.reserveAttempt('fresh', 10_001, window)).toEqual({
      allowed: true,
      count: 2,
    });
  });

  it('a principal inside its window keeps its lock through sweeps', async () => {
    const store = new MemoryTotpStore();
    const window = { limit: 5, windowMs: 1_000 };
    for (let i = 0; i < 5; i++) await store.reserveAttempt('victim', 20_000, window);
    // Enough distinct ids to trigger several sweeps.
    for (let i = 0; i < 5_000; i++) await store.reserveAttempt(`burst-${i}`, 20_500, window);
    expect((await store.reserveAttempt('victim', 20_600, window)).allowed).toBe(false);
    // And a fresh principal is counted, not swept away mid-count.
    expect(await store.reserveAttempt('fresh', 20_700, window)).toEqual({
      allowed: true,
      count: 1,
    });
    expect(await store.reserveAttempt('fresh', 20_701, window)).toEqual({
      allowed: true,
      count: 2,
    });
  });
});

describe('sweepExpiredAttempts', () => {
  const entries = (n: number, ts: number) =>
    new Map(Array.from({ length: n }, (_, i) => [`id-${i}`, { timestamps: [ts] }]));

  it('does nothing below the threshold', () => {
    const map = entries(10, 0);
    expect(sweepExpiredAttempts(map, 100, 1_024)).toBe(1_024);
    expect(map.size).toBe(10);
  });

  it('drops only fully expired entries and doubles the threshold from what survives', () => {
    const map = entries(3_000, 0);
    map.set('live', { timestamps: [0, 500] });
    expect(sweepExpiredAttempts(map, 100, 1_024)).toBe(1_024);
    expect([...map.keys()]).toEqual(['live']);

    const busy = entries(2_000, 500);
    expect(sweepExpiredAttempts(busy, 100, 1_024)).toBe(4_000);
    expect(busy.size).toBe(2_000);
  });
});
