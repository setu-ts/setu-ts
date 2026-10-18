import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachSchedulerCollector,
  SchedulerService,
} from '../../src/services/scheduler-service.ts';
import { SchedulerObservationCollector } from '../../src/diagnostics/scheduler-observations.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A MemoryLock whose `:once` releases wait on a gate (or never settle). */
class GatedReleaseLock extends MemoryLock {
  gate: Promise<void> | null = null;
  override async release(key: string, token: string): Promise<void> {
    if (key.endsWith(':once') && this.gate !== null) await this.gate;
    return super.release(key, token);
  }
}

/** A MemoryLock whose `:once` acquires wait on a gate while it is set. */
class GatedAcquireLock extends MemoryLock {
  gate: Promise<void> | null = null;
  override async acquire(key: string, ttlMs: number): Promise<string | null> {
    if (key.endsWith(':once') && this.gate !== null) await this.gate;
    return super.acquire(key, ttlMs);
  }
}

describe('scheduler lifecycle races (M113m audit round 3)', () => {
  const services: SchedulerService[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) await service.disconnect();
  });

  function track(service: SchedulerService): SchedulerService {
    services.push(service);
    return service;
  }

  it('F1: remove() resolves when the one-shot settles while its slot release is awaited', async () => {
    const runtime = new FakeRuntime();
    const lock = new GatedReleaseLock(runtime);
    const service = track(new SchedulerService(runtime, lock, { acquireTimeoutMs: 0 }));
    await service.connect();
    const handlerGate = deferred();
    await service.delay('job', 0, () => handlerGate.promise);
    await runtime.advanceTo(runtime.now());

    const releaseGate = deferred();
    lock.gate = releaseGate.promise;
    const removal = service.remove('job');
    handlerGate.resolve();
    await runtime.advanceTo(runtime.now());
    // The old fire removed the entry; a replacement is registered meanwhile.
    lock.gate = null;
    await service.delay('job', 1_000, () => {});
    releaseGate.resolve();

    await expect(removal).resolves.toBeUndefined();
    await expect(service.getNextRun('job')).resolves.toBeTypeOf('number');
  });

  it('F2: resume() rejects on a disconnected service', async () => {
    const runtime = new FakeRuntime();
    const service = track(new SchedulerService(runtime, new MemoryLock(runtime)));
    await service.connect();
    await service.delay('job', 100, () => {});
    await service.pause('job');
    await service.disconnect();
    await expect(service.resume('job')).rejects.toThrow('SchedulerService is not connected');
  });

  it('F2: a slot released at disconnect is re-claimed on resume, so only one replica runs', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const a = track(new SchedulerService(runtime, lock));
    const b = track(new SchedulerService(runtime, lock));
    await a.connect();
    await b.connect();
    const runsA = vi.fn();
    const runsB = vi.fn();

    await a.delay('job', 100, runsA);
    await a.pause('job');
    await a.disconnect(); // releases A's `:once` slot
    await b.delay('job', 100, runsB); // B claims the freed slot
    await a.connect();
    await a.resume('job'); // A must re-claim, and find B holding it

    await runtime.advanceTo(runtime.now() + 200);
    expect(runsB).toHaveBeenCalledTimes(1);
    expect(runsA).not.toHaveBeenCalled();
  });

  it('F3: disconnect() is bounded when a slot release never settles', async () => {
    const runtime = new FakeRuntime();
    const lock = new GatedReleaseLock(runtime);
    const service = new SchedulerService(runtime, lock, { acquireTimeoutMs: 50 });
    await service.connect();
    await service.delay('job', 10_000, () => {});
    lock.gate = new Promise<void>(() => {});

    let settled = false;
    const disconnecting = service.disconnect().then(() => {
      settled = true;
    });
    await runtime.advanceTo(runtime.now() + 49);
    expect(settled).toBe(false);
    await runtime.advanceTo(runtime.now() + 1);
    await disconnecting;
    expect(settled).toBe(true);
  });

  it('F4: pause+resume during a running attempt neither overlaps it nor loses the one-shot', async () => {
    const runtime = new FakeRuntime();
    const service = track(new SchedulerService(runtime, new MemoryLock(runtime)));
    const collector = new SchedulerObservationCollector(
      'scheduler',
      new Map([['job', 'job']]),
      () => runtime.now(),
      () => runtime.hrtime(),
    );
    const settled = vi.spyOn(collector, 'fireSettled');
    attachSchedulerCollector(service, collector);
    await service.connect();

    const firstAttempt = deferred();
    let calls = 0;
    const handler = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        await firstAttempt.promise;
        throw new Error('first attempt fails');
      }
    });
    await service.delay('job', 0, handler, { retry: { limit: 3, delay: 10, backoff: 'fixed' } });
    await runtime.advanceTo(runtime.now());
    expect(handler).toHaveBeenCalledTimes(1);

    await service.pause('job');
    await service.resume('job');
    // No resumed fire may start while attempt 1 still runs.
    await runtime.advanceTo(runtime.now() + 100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls.some(([, kind]) => kind === 'contended')).toBe(false);

    firstAttempt.resolve();
    await runtime.advanceTo(runtime.now() + 100);
    // The cancelled run is kept, re-armed when it settles, and runs from attempt 1.
    expect(handler).toHaveBeenCalledTimes(2);
    expect(settled.mock.calls.map(([, kind, ok]) => [kind, ok])).toEqual([
      ['dispatched', false],
      ['dispatched', true],
    ]);
    await expect(service.getNextRun('job')).rejects.toThrow('No scheduled job');
  });

  it('F4: pausing again before the in-flight fire settles leaves the job paused', async () => {
    const runtime = new FakeRuntime();
    const service = track(new SchedulerService(runtime, new MemoryLock(runtime)));
    await service.connect();
    const gate = deferred();
    const handler = vi.fn(async () => {
      await gate.promise;
      throw new Error('fails');
    });
    await service.delay('job', 0, handler, { retry: { limit: 3, delay: 10, backoff: 'fixed' } });
    await runtime.advanceTo(runtime.now());

    await service.pause('job');
    await service.resume('job');
    await service.pause('job');
    gate.resolve();
    await runtime.advanceTo(runtime.now() + 1_000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtime.getPendingTimerCount()).toBe(0);
    // Still registered and resumable.
    await service.resume('job');
    await runtime.advanceTo(runtime.now() + 1_000);
    expect(handler).toHaveBeenCalledTimes(4);
  });
});

describe('resume re-claim races (M113m audit round 4)', () => {
  const services: SchedulerService[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) await service.disconnect();
  });

  /** A paused one-shot whose slot was released at disconnect, reconnected. */
  async function released(lock: GatedAcquireLock, runtime: FakeRuntime) {
    const service = new SchedulerService(runtime, lock);
    services.push(service);
    await service.connect();
    const handler = vi.fn();
    await service.delay('job', 100, handler);
    await service.pause('job');
    await service.disconnect();
    await service.connect();
    const gate = deferred();
    lock.gate = gate.promise;
    return { service, handler, gate };
  }

  it('G1: a pause during the re-claim wins over the resume', async () => {
    const runtime = new FakeRuntime();
    const lock = new GatedAcquireLock(runtime);
    const { service, handler, gate } = await released(lock, runtime);
    const resuming = service.resume('job');
    await service.pause('job');
    gate.resolve();
    await resuming;
    await runtime.advanceTo(runtime.now() + 1_000);
    expect(handler).not.toHaveBeenCalled();
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('G1: two concurrent resumes claim once and run the job once', async () => {
    const runtime = new FakeRuntime();
    const lock = new GatedAcquireLock(runtime);
    const { service, handler, gate } = await released(lock, runtime);
    const acquires = vi.spyOn(lock, 'acquire');
    const first = service.resume('job');
    const second = service.resume('job');
    gate.resolve();
    await Promise.all([first, second]);
    await runtime.advanceTo(runtime.now() + 1_000);
    expect(acquires.mock.calls.filter(([key]) => key.endsWith(':once'))).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('G1: a remove during the re-claim releases the slot it took', async () => {
    const runtime = new FakeRuntime();
    const lock = new GatedAcquireLock(runtime);
    const { service, gate } = await released(lock, runtime);
    const resuming = service.resume('job');
    await service.remove('job');
    gate.resolve();
    await resuming;
    lock.gate = null;
    const other = new SchedulerService(runtime, lock);
    services.push(other);
    await other.connect();
    const otherRuns = vi.fn();
    await other.delay('job', 10, otherRuns);
    await runtime.advanceTo(runtime.now() + 1_000);
    expect(otherRuns).toHaveBeenCalledTimes(1);
  });

  it('G1: a disconnect during the re-claim neither arms the job nor keeps the slot', async () => {
    const runtime = new FakeRuntime();
    const lock = new GatedAcquireLock(runtime);
    const { service, handler, gate } = await released(lock, runtime);
    const resuming = service.resume('job');
    await service.disconnect();
    gate.resolve();
    await resuming;
    await runtime.advanceTo(runtime.now() + 1_000);
    expect(handler).not.toHaveBeenCalled();
    expect(runtime.getPendingTimerCount()).toBe(0);
    lock.gate = null;
    expect(await lock.acquire('scheduler:job:job:once', 1_000)).not.toBeNull();
  });

  it('G2: a job resumed after reconnecting is stopped by the next disconnect', async () => {
    const runtime = new FakeRuntime();
    const service = new SchedulerService(runtime, new MemoryLock(runtime));
    services.push(service);
    await service.connect();
    const handler = vi.fn();
    await service.every('tick', 100, handler);
    await service.pause('tick');
    await service.disconnect();
    await service.connect();
    await service.resume('tick');
    await service.disconnect();
    await runtime.advanceTo(runtime.now() + 1_000);
    expect(handler).not.toHaveBeenCalled();
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('G3: a fire that rejects is contained and logged', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const error = vi.fn();
    const logger = {
      level: 'debug' as const,
      fatal: vi.fn(),
      error,
      warn: vi.fn(),
      info: vi.fn(),
      debug: () => {
        throw new Error('canary-logger-throw');
      },
      trace: vi.fn(),
      child: () => logger,
    };
    // A second replica holds the slot, so this fire takes the contended path,
    // where the debug log throws and the fire rejects.
    const holder = new SchedulerService(runtime, lock);
    services.push(holder);
    await holder.connect();
    await holder.delay('job', 10, () => {});
    const service = new SchedulerService(runtime, lock, { logger });
    services.push(service);
    await service.connect();
    await service.delay('job', 10, () => {});
    await runtime.advanceTo(runtime.now() + 100);
    expect(error).toHaveBeenCalledWith("Job 'job': fire failed unexpectedly", {
      error: 'canary-logger-throw',
    });
  });
});
