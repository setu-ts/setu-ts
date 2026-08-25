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

  it('two replicas registering the SAME delay 700 ms apart run it exactly once (F2)', async () => {
    // F2 regression: the delay fire slot was keyed on `nextRunAtMs`, which
    // for a delay is `now + delayMs` and therefore carries per-replica
    // startup skew. Two replicas registering the same one-shot delay 700 ms
    // apart computed slots 700 ms apart — different keys — and BOTH ran.
    // The slot is now claimed at registration, keyed on the job name
    // (skew-independent): replica A claims it, replica B's registration
    // finds it held and marks its entry not-claimed, so when both timers
    // fire, only A runs the handler.
    const runtimeA = new FakeRuntime(); // T0
    const runtimeB = new FakeRuntime();
    await runtimeB.advance(700); // 0.7 s of replica skew
    const sharedLock = new MemoryLock(runtimeA);

    const runs: string[] = [];
    const serviceA = new SchedulerService(runtimeA, sharedLock);
    await serviceA.connect();
    await serviceA.delay('one-shot', 1000, () => {
      runs.push('A');
    });

    const serviceB = new SchedulerService(runtimeB, sharedLock);
    await serviceB.connect();
    // B's registration finds the name slot A claimed — B must NOT run.
    await serviceB.delay('one-shot', 1000, () => {
      runs.push('B');
    });

    // Both timers fire within the same window; the slot claim decided at
    // registration time, not the fire-time instants (which differ by 700 ms).
    await runtimeA.advance(1000);
    await runtimeB.advance(1000);

    expect(runs).toEqual(['A']);
  });

  it('a delay job re-registered under the same name within ttlMs fires again (C1)', async () => {
    // C1 regression, reconciled with F2: the `delay` arm first keyed its fire
    // slot on the literal `'once'` and never released it, so after a delay
    // job fired — `#fire` removes it from the registry, making re-registration
    // under the same name legal (retry/backoff flows) — the second
    // registration's fire found its slot already claimed and was silently
    // dropped. F2 then keyed the slot on `nextRunAtMs`, which broke replica
    // dedup (skew). The reconciliation: the slot is keyed on the job NAME and
    // claimed at registration, but it is RELEASED when the entry leaves the
    // registry (here: on fire), so the re-registration below gets a fresh
    // slot and fires again — while two replicas registering the SAME delay
    // still collide on the one name slot (the dedup X10-2 wants).
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
    // first registration's stale slot claim.
    expect(runs).toEqual([1, 2]);
  });

  it('remove() of a never-fired delay releases its slot so the name can be re-registered (F2)', async () => {
    // F2: the slot is released on EVERY path by which a delay entry leaves
    // the registry — fire, remove, or TTL expiry. Without the remove()
    // release, a cancelled delay would hold its name slot for the whole TTL
    // and a re-registration would be silently dropped for that window.
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();

    const runs: string[] = [];
    await service.delay('cancelled', 5000, () => {
      runs.push('first');
    });
    // The registration claimed the name slot.
    expect(lock.size).toBe(1);

    // Cancel before it fires: the entry leaves the registry and must
    // release the slot.
    await service.remove('cancelled');
    expect(lock.size).toBe(0);

    // Re-registration under the same name gets a fresh slot and fires.
    await service.delay('cancelled', 1000, () => {
      runs.push('second');
    });
    await runtime.advance(1000);
    expect(runs).toEqual(['second']);
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
