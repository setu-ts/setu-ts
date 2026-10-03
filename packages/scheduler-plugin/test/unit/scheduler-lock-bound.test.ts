/**
 * M101a V8-24: a lock acquire that never settles is bounded by
 * `acquireTimeoutMs` at all three acquire sites — the `every`/`cron` fire
 * slot, the handler mutex, and the `delay` slot claimed at registration.
 * The bound's rejection takes the existing catch arm (logged, the fire counted
 * `lock-failed`, the schedule re-armed), and an acquire abandoned at the bound
 * that later returns a token has that exact token released.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger } from '@setu-ts/common';

import { SchedulerService } from '../../src/services/scheduler-service.ts';
import { attachSchedulerCollector } from '../../src/services/scheduler-service.ts';
import { SchedulerObservationCollector } from '../../src/diagnostics/scheduler-observations.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import type { IDistributedLock } from '../../src/interfaces/index.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

const BOUND_MS = 1000;
// The fake runtime's clock starts at 1_700_000_000_000, so a 100 ms `every`
// job's first grid slot is 1_700_000_000_100.
const SLOT_KEY = 'scheduler:job:tick:1700000000100';
const MUTEX_KEY = 'scheduler:job:tick';
const DELAY_KEY = 'scheduler:job:tick:once';

/** Lets every pending microtask and zero-delay macrotask run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Collects error-level log lines. */
function recordingLogger() {
  const errors: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
  const logger = {
    error: (msg: string, meta?: Record<string, unknown>) => errors.push({ msg, meta }),
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => logger,
  } as unknown as ILogger;
  return { logger, errors };
}

/**
 * A lock over a real `MemoryLock` whose FIRST acquire of `heldKey` returns a
 * promise the test settles by hand; every other acquire goes straight through.
 */
function controllableLock(runtime: FakeRuntime, heldKey: string) {
  const memory = new MemoryLock(runtime);
  const releases: Array<[string, string]> = [];
  let held: PromiseWithResolvers<string | null> | null = null;
  let releaseFails = false;
  const lock: IDistributedLock = {
    acquire: (key, ttlMs) => {
      if (key === heldKey && held === null) {
        held = Promise.withResolvers<string | null>();
        return held.promise;
      }
      return memory.acquire(key, ttlMs);
    },
    release: (key, token) => {
      releases.push([key, token]);
      if (releaseFails) return Promise.reject(new Error('release-canary'));
      return memory.release(key, token);
    },
  };
  return {
    lock,
    memory,
    releases,
    /** Settles the held acquire with what a real acquire would have returned. */
    lateAcquire: async (): Promise<string> => {
      const token = await memory.acquire(heldKey, 30_000);
      held!.resolve(token);
      return token!;
    },
    lateNull: () => held!.resolve(null),
    lateReject: () => held!.reject(new Error('late-canary')),
    failReleases: () => {
      releaseFails = true;
    },
  };
}

function observedService(
  runtime: FakeRuntime,
  lock: IDistributedLock,
  acquireTimeoutMs = BOUND_MS,
) {
  const { logger, errors } = recordingLogger();
  const service = new SchedulerService(runtime, lock, { logger, acquireTimeoutMs });
  const collector = new SchedulerObservationCollector(
    'cron',
    new Map([['tick', 'tick-alias']]),
    runtime.now.bind(runtime),
    runtime.hrtime.bind(runtime),
  );
  attachSchedulerCollector(service, collector);
  const fire = () =>
    collector.snapshot().records.find((r) => r.alias === 'tick-alias' && r.operation === 'fire');
  return { service, errors, fire };
}

/** Starts the `every` fire due at 100 ms, then fires the acquire bound. */
async function fireAndExpire(runtime: FakeRuntime): Promise<void> {
  const firing = runtime.advance(100);
  await flush();
  await runtime.advance(BOUND_MS);
  await firing;
}

describe('SchedulerService acquire bound (M101a V8-24)', () => {
  it('a hung fire-slot acquire settles lock-failed at the bound and the next slot is armed', async () => {
    const runtime = new FakeRuntime();
    const control = controllableLock(runtime, SLOT_KEY);
    const { service, errors, fire } = observedService(runtime, control.lock);
    await service.connect();
    let fired = 0;
    await service.every('tick', 100, () => {
      fired++;
    });

    await fireAndExpire(runtime);

    expect(fire()).toMatchObject({ count: 1, lockFailed: 1, contended: 0 });
    expect(errors.length).toBe(1);
    expect(errors[0].msg).toBe("Job 'tick': could not claim fire slot");
    expect(errors[0].meta?.['error']).toBe(`lock acquire did not settle within ${BOUND_MS} ms`);
    // The schedule re-armed: the next slot fires and runs the handler.
    expect(runtime.getPendingTimerCount()).toBe(1);
    await runtime.advance(runtime.getNextTimerDelay()!);
    expect(fired).toBe(1);
    await service.disconnect();
  });

  it('a hung handler-mutex acquire settles lock-failed and skips only that fire', async () => {
    const runtime = new FakeRuntime();
    const control = controllableLock(runtime, MUTEX_KEY);
    const { service, errors, fire } = observedService(runtime, control.lock);
    await service.connect();
    let fired = 0;
    await service.every('tick', 100, () => {
      fired++;
    });

    await fireAndExpire(runtime);

    expect(fire()).toMatchObject({ count: 1, lockFailed: 1 });
    expect(errors.map((e) => e.msg)).toEqual(["Job 'tick': could not acquire lock"]);
    expect(fired).toBe(0);
    expect(runtime.getPendingTimerCount()).toBe(1);
    await service.disconnect();
  });

  it('a hung delay-slot claim at registration is bounded and the run is skipped', async () => {
    const runtime = new FakeRuntime();
    const control = controllableLock(runtime, DELAY_KEY);
    const { service, errors } = observedService(runtime, control.lock);
    await service.connect();
    let fired = 0;
    const registering = service.delay('tick', 10_000, () => {
      fired++;
    });
    await flush();
    await runtime.advance(BOUND_MS);
    await registering;

    expect(errors.map((e) => e.msg)).toEqual(["Job 'tick': could not claim fire slot"]);
    await runtime.advance(runtime.getNextTimerDelay()!);
    expect(fired).toBe(0);
    await service.disconnect();
  });

  it('acquireTimeoutMs: 0 waits for the acquire and arms no bound', async () => {
    const runtime = new FakeRuntime();
    const control = controllableLock(runtime, SLOT_KEY);
    const { service, fire } = observedService(runtime, control.lock, 0);
    await service.connect();
    await service.every('tick', 100, () => {});

    const firing = runtime.advance(100);
    await flush();
    // No timer at all: the job timer fired, and no deadline was armed.
    expect(runtime.getPendingTimerCount()).toBe(0);
    // Advancing would await the parked fire, so let real time pass instead:
    // with nothing armed, nothing can expire it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fire()?.lockFailed ?? 0).toBe(0);

    await control.lateAcquire();
    await firing;
    expect(fire()).toMatchObject({ count: 1, lockFailed: 0 });
    expect(control.releases).not.toContainEqual([SLOT_KEY, expect.anything()]);
    await service.disconnect();
  });

  for (
    const [site, key] of [
      ['fire slot', SLOT_KEY],
      ['handler mutex', MUTEX_KEY],
      ['delay slot', DELAY_KEY],
    ] as const
  ) {
    it(`releases a token the abandoned ${site} acquire returns after the bound`, async () => {
      const runtime = new FakeRuntime();
      const control = controllableLock(runtime, key);
      const { service } = observedService(runtime, control.lock);
      await service.connect();
      if (key === DELAY_KEY) {
        const registering = service.delay('tick', 10_000, () => {});
        await flush();
        await runtime.advance(BOUND_MS);
        await registering;
      } else {
        await service.every('tick', 100, () => {});
        await fireAndExpire(runtime);
      }

      const token = await control.lateAcquire();
      await flush();

      expect(control.releases).toContainEqual([key, token]);
      // The key is free again — not held until its TTL by a token nobody owns.
      expect(await control.memory.acquire(key, 1000)).not.toBeNull();
      await service.disconnect();
    });
  }

  it("the next fire's mutex acquire is not contended by the abandoned token", async () => {
    const runtime = new FakeRuntime();
    const control = controllableLock(runtime, MUTEX_KEY);
    const { service, fire } = observedService(runtime, control.lock);
    await service.connect();
    let fired = 0;
    await service.every('tick', 100, () => {
      fired++;
    });
    await fireAndExpire(runtime);
    await control.lateAcquire();
    await flush();

    await runtime.advance(runtime.getNextTimerDelay()!);
    expect(fired).toBe(1);
    expect(fire()).toMatchObject({ count: 2, lockFailed: 1, contended: 0 });
    await service.disconnect();
  });

  it('a late null and a late rejection release nothing', async () => {
    for (const settle of ['null', 'reject'] as const) {
      const runtime = new FakeRuntime();
      const control = controllableLock(runtime, SLOT_KEY);
      const { service } = observedService(runtime, control.lock);
      await service.connect();
      await service.every('tick', 100, () => {});
      await fireAndExpire(runtime);
      if (settle === 'null') control.lateNull();
      else control.lateReject();
      await flush();
      expect(control.releases).toEqual([]);
      await service.disconnect();
    }
  });

  it('logs a failed release of an abandoned token once and keeps going', async () => {
    const runtime = new FakeRuntime();
    const control = controllableLock(runtime, SLOT_KEY);
    const { service, errors } = observedService(runtime, control.lock);
    await service.connect();
    await service.every('tick', 100, () => {});
    await fireAndExpire(runtime);
    control.failReleases();
    await control.lateAcquire();
    await flush();

    const abandoned = errors.filter((e) => e.msg.includes('abandoned lock'));
    expect(abandoned).toEqual([{
      msg: "Job 'tick': could not release an abandoned lock",
      meta: { error: 'release-canary' },
    }]);
    await service.disconnect();
  });

  it('stringifies a non-Error release failure of an abandoned token', async () => {
    const runtime = new FakeRuntime();
    const memory = new MemoryLock(runtime);
    let held: PromiseWithResolvers<string | null> | null = null;
    const lock: IDistributedLock = {
      acquire: (key, ttlMs) => {
        if (held === null) {
          held = Promise.withResolvers<string | null>();
          return held.promise;
        }
        return memory.acquire(key, ttlMs);
      },
      release: () => Promise.reject('plain-string'),
    };
    const { service, errors } = observedService(runtime, lock);
    await service.connect();
    await service.every('tick', 100, () => {});
    await fireAndExpire(runtime);
    held!.resolve('late');
    await flush();
    expect(errors.find((e) => e.msg.includes('abandoned lock'))?.meta).toEqual({
      error: 'plain-string',
    });
    await service.disconnect();
  });

  it('refuses an out-of-range acquireTimeoutMs at construction', () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    for (const value of [Number.NaN, -1, 2 ** 31, Number.POSITIVE_INFINITY]) {
      expect(() => new SchedulerService(runtime, lock, { acquireTimeoutMs: value })).toThrow(
        RangeError,
      );
    }
  });
});
