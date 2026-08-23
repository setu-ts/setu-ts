/**
 * X10-2: per-fire deduplication across replicas, with overlap protection
 * preserved.
 *
 * The register's defect: a scheduled job runs once PER REPLICA, and the one
 * documented remedy (`distributedLock`) deduplicates nothing — the lock was a
 * per-handler OVERLAP mutex keyed without any fire identity, so replicas whose
 * timers fired at slightly different instants each acquired it in turn.
 *
 * The fix is TWO locks (C3), because dedup and overlap are different
 * questions: a never-released slot lock keyed on the fire's INTENDED time
 * (`scheduler:job:<name>:<slot>`) gives per-fire dedup; the existing handler
 * mutex keeps its overlap role. These tests drive two SchedulerService
 * instances over ONE shared MemoryLock — the reachable equivalent of two
 * replicas sharing a Redis backend; its limitation (no real second process)
 * is stated rather than implied.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SchedulerService } from '../../src/services/scheduler-service.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('SchedulerService fire-slot deduplication', () => {
  it('two replicas offset WITHIN a slot run the handler exactly once between them', async () => {
    const runtimeA = new FakeRuntime(); // T0
    const runtimeB = new FakeRuntime();
    await runtimeB.advance(700); // 0.7 s of replica skew
    const sharedLock = new MemoryLock(runtimeA);

    const runs: string[] = [];
    const serviceA = new SchedulerService(runtimeA, sharedLock);
    await serviceA.connect();
    await serviceA.every('nightly', 3000, () => {
      runs.push('A');
    });

    const serviceB = new SchedulerService(runtimeB, sharedLock);
    await serviceB.connect();
    await serviceB.every('nightly', 3000, () => {
      runs.push('B');
    });

    // Grid alignment (§3.3) makes both replicas compute the SAME intended
    // slot despite the skew — this assertion is what fails if §3.3 is
    // reverted while the slot key stays.
    expect(await serviceB.getNextRun('nightly')).toBe(await serviceA.getNextRun('nightly'));

    await runtimeA.advance(3000);
    await runtimeB.advance(3000);

    // Both timers fired; only ONE handler ran, because B's slot claim lost.
    expect(runs).toEqual(['A']);
  });

  it('two replicas offset ACROSS slots each run once', async () => {
    const runtimeA = new FakeRuntime();
    const runtimeB = new FakeRuntime();
    // Past the next grid boundary: B's first intended slot is a DIFFERENT one.
    await runtimeB.advance(3100);
    const sharedLock = new MemoryLock(runtimeA);

    const runs: string[] = [];
    const serviceA = new SchedulerService(runtimeA, sharedLock);
    await serviceA.connect();
    await serviceA.every('nightly', 3000, () => {
      runs.push('A');
    });

    const serviceB = new SchedulerService(runtimeB, sharedLock);
    await serviceB.connect();
    await serviceB.every('nightly', 3000, () => {
      runs.push('B');
    });

    expect(await serviceB.getNextRun('nightly'))
      .not.toBe(await serviceA.getNextRun('nightly'));

    await runtimeA.advance(3000);
    await runtimeB.advance(3000);

    // Different slots: both replicas legitimately run their own fire.
    expect(runs.sort()).toEqual(['A', 'B']);
  });

  it('a delay job re-registered under the same name within ttlMs fires again (C1)', async () => {
    // C1 regression: the `delay` arm used to key its fire slot on the literal
    // `'once'` instead of the intended fire time. After a delay job fired,
    // `#fire` removed it from the registry — so re-registering under the same
    // name is legal (retry/backoff flows) — but the second registration's fire
    // called `acquire('…:once')`, got `null` ("slot already claimed"), and was
    // silently dropped because the never-released first slot still held the
    // key within ttlMs. Keying on `nextRunAtMs` gives each distinct intended
    // fire its own slot while two replicas registering the SAME delay still
    // collide on one instant (the dedup X10-2 wants).
    const runtime = new FakeRuntime();
    const service = new SchedulerService(runtime, new MemoryLock(runtime));
    await service.connect();

    const runs: number[] = [];
    await service.delay('retryable', 1000, () => {
      runs.push(1);
    });
    await runtime.advance(1000);

    // First fire ran once and removed itself from the registry.
    expect(runs).toEqual([1]);

    // Re-registration under the freed name — a NEW intended fire time.
    await service.delay('retryable', 1000, () => {
      runs.push(2);
    });
    await runtime.advance(1000);

    // The second fire must run on its own slot, not be swallowed by the
    // first registration's stale `'once'` slot claim.
    expect(runs).toEqual([1, 2]);
  });

  it('a still-running previous fire is still skipped — the overlap mutex survives', async () => {
    // The negative consequence the naive "slot lock only" fix would have
    // shipped: slot N+1 is a different key from slot N, so replacing the old
    // mutex outright would let an overlapping fire of the same job run
    // concurrently. Here replica A holds the HANDLER MUTEX with a gated slow
    // handler while replica B — whose intended slot differs — fires; B must
    // claim its own slot fine and then be stopped by the mutex.
    const runtimeA = new FakeRuntime();
    const runtimeB = new FakeRuntime();
    await runtimeB.advance(3100); // different grid slot from A
    const sharedLock = new MemoryLock(runtimeA);

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runs: string[] = [];
    const serviceA = new SchedulerService(runtimeA, sharedLock);
    await serviceA.connect();
    await serviceA.every('heavy', 3000, () => {
      runs.push('A');
      return gate;
    });

    let bRan = false;
    const serviceB = new SchedulerService(runtimeB, sharedLock);
    await serviceB.connect();
    await serviceB.every('heavy', 3000, () => {
      bRan = true;
    });

    // Start A's fire WITHOUT awaiting: the handler is now in flight holding
    // the handler mutex.
    const fireA = runtimeA.advance(3000);

    // B's timer fires while A's handler is still running.
    await runtimeB.advance(3000);

    releaseFirst();
    await fireA;

    expect(runs).toEqual(['A']);
    expect(bRan).toBe(false);
  });
});
