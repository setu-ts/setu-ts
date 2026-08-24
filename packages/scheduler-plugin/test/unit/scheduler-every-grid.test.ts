/**
 * X10-2 §3.3: `every` arms on an absolute epoch grid.
 *
 * Without this, the slot-lock mechanism looks like a fix but is not: two
 * replicas started 0.7 s apart compute `nextRunAtMs` values 0.7 s apart
 * FOREVER, so their slot keys never collide and both replicas run every
 * tick. Grid alignment (`(floor(now / interval) + 1) * interval`) preserves
 * the period exactly and changes only the phase — which additionally makes
 * `every` deterministic across restarts.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SchedulerService } from '../../src/services/scheduler-service.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

const INTERVAL = 3000;

/** The formula under test, spelled out for exact-value assertions. */
function gridNext(now: number): number {
  return (Math.floor(now / INTERVAL) + 1) * INTERVAL;
}

describe('SchedulerService `every` grid alignment', () => {
  it('the first fire lands on an epoch multiple of the interval', async () => {
    const runtime = new FakeRuntime();
    await runtime.advance(1000); // deliberately OFF the grid
    const service = new SchedulerService(runtime, new MemoryLock(runtime));
    await service.connect();
    await service.every('tick', INTERVAL, () => {});

    const nextRun = await service.getNextRun('tick');
    expect(nextRun).toBe(gridNext(runtime.now()));
    expect(nextRun % INTERVAL).toBe(0);
    // Never later than one interval after registration.
    expect(nextRun - runtime.now()).toBeLessThanOrEqual(INTERVAL);
  });

  it('two services registered 700 ms apart compute IDENTICAL next-run times', async () => {
    const runtimeA = new FakeRuntime();
    const runtimeB = new FakeRuntime();
    await runtimeB.advance(700);

    const serviceA = new SchedulerService(runtimeA, new MemoryLock(runtimeA));
    await serviceA.connect();
    await serviceA.every('tick', INTERVAL, () => {});

    const serviceB = new SchedulerService(runtimeB, new MemoryLock(runtimeB));
    await serviceB.connect();
    await serviceB.every('tick', INTERVAL, () => {});

    expect(await serviceB.getNextRun('tick')).toBe(await serviceA.getNextRun('tick'));
  });

  it('an off-grid registration arms for the delay to the boundary, not a full interval (F1)', async () => {
    // F1 regression: `every()` computed a grid-aligned `nextRunAtMs` but
    // armed the timer for the full `intervalMs`. The FakeRuntime base time
    // (1700000000000) sits 1000 ms BEFORE the next 3000 ms boundary
    // (1700000001000), so the intended delay is 1000 ms — arming for 3000
    // ms runs the job two full intervals LATER than the boundary, defeating
    // the grid alignment (and the slot agreement it exists for).
    const runtime = new FakeRuntime();
    const service = new SchedulerService(runtime, new MemoryLock(runtime));
    await service.connect();

    let firedAt = -1;
    await service.every('tick', INTERVAL, () => {
      firedAt = runtime.now();
    });

    // The armed delay is the distance to the boundary, not the interval.
    expect(runtime.getNextTimerDelay()).toBe(1000);

    // A full-interval advance would NOT have fired the job yet if the
    // timer had been armed for 3000 ms: the boundary is reached at T0+1000.
    await runtime.advance(1000);
    expect(firedAt).toBe(runtime.now());
    expect(firedAt % INTERVAL).toBe(0); // the boundary, not T0 + 3000
    expect(firedAt).toBe(1_700_000_001_000);

    // Re-arm after the fire: the next boundary is exactly one interval out.
    expect(runtime.getNextTimerDelay()).toBe(INTERVAL);
  });

  it('re-arm lands back on the grid', async () => {
    const runtime = new FakeRuntime();
    const service = new SchedulerService(runtime, new MemoryLock(runtime));
    await service.connect();
    let runs = 0;
    await service.every('tick', INTERVAL, () => {
      runs++;
    });

    await runtime.advance(INTERVAL);

    expect(runs).toBe(1);
    const nextRun = await service.getNextRun('tick');
    expect(nextRun).toBe(gridNext(runtime.now()));
    expect(nextRun % INTERVAL).toBe(0);
    expect(nextRun).toBeGreaterThan(runtime.now() - INTERVAL);
  });

  it('resume lands on the grid', async () => {
    const runtime = new FakeRuntime();
    const service = new SchedulerService(runtime, new MemoryLock(runtime));
    await service.connect();
    await service.every('tick', INTERVAL, () => {});
    await service.pause('tick');

    // Resume at an off-grid instant.
    await runtime.advance(1234);
    await service.resume('tick');

    const nextRun = await service.getNextRun('tick');
    expect(nextRun).toBe(gridNext(runtime.now()));
    expect(nextRun % INTERVAL).toBe(0);
  });
});
