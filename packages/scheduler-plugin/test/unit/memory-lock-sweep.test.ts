/**
 * X10-2 §3.4: `MemoryLock.acquire` sweeps every expired entry.
 *
 * The scheduler's fire-slot keys are never released and never reacquired, so
 * the previous lazy per-key delete (which ran only when THAT key was next
 * acquired) could never reclaim them: the default single-process
 * configuration would grow one map entry per job per fire, forever — a memory
 * leak every gate passes. These tests fail without the sweep: the first key's
 * entry stays in the map after expiry, so re-acquiring it reports "held" and
 * the size grows with N instead of staying bounded by jobs × ttl ÷ interval.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('MemoryLock expired-key sweep', () => {
  it('reclaims expired slot keys it will never see again', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const TTL = 1000;

    // 100 distinct slot keys spanning 5× the TTL. With a full sweep the map
    // stays bounded (~ttl ÷ step entries); without it grows to exactly N.
    for (let i = 0; i < 100; i++) {
      await runtime.advance(50);
      const token = await lock.acquire(`scheduler:job:j:${1700000000000 + i * 50}`, TTL);
      expect(token).not.toBeNull();
    }

    // Bounded: only keys acquired within the last TTL can still be held.
    expect(lock.size).toBeLessThan(100);
    expect(lock.size).toBeLessThanOrEqual(TTL / 50 + 1);

    // The discriminating assertion: the FIRST key expired long ago and is
    // never reacquired under its original identity — without the sweep its
    // dead entry still answers "held".
    const reacquired = await lock.acquire('scheduler:job:j:1700000000000', TTL);
    expect(reacquired).not.toBeNull();
  });

  it('still refuses a key that has NOT expired', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);

    const first = await lock.acquire('active', 10_000);
    expect(first).not.toBeNull();
    await runtime.advance(500);
    const second = await lock.acquire('active', 10_000);
    expect(second).toBeNull();

    // And the holder's release still works after sweeps have run.
    await lock.release('active', first as string);
    const third = await lock.acquire('active', 10_000);
    expect(third).not.toBeNull();
  });
});
