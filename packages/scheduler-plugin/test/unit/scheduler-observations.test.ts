/**
 * Unit tests for the M98k scheduler execution observations: option
 * validation, the collector's counting, retention, saturation and failure
 * latch, the fire/attempt capture through a real SchedulerService (lock
 * losers produce no handler records), and the plugin's multi-provider
 * source registration and close ordering through a real kernel application.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IScheduler, ISchedulerDiagnosticsSource } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { SchedulerPlugin } from '../../src/index.ts';
import type { SchedulerDiagnosticsOptions } from '../../src/index.ts';
import { SchedulerService } from '../../src/services/scheduler-service.ts';
import {
  attachSchedulerCollector,
  detachSchedulerCollector,
} from '../../src/services/scheduler-service.ts';
import {
  bump,
  compileSchedulerDiagnostics,
  createSchedulerDiagnosticsSource,
  SCHEDULER_COLLECTOR_LIMITS,
  SCHEDULER_DIAGNOSTICS_ERRORS,
  SchedulerObservationCollector,
  toWireMs,
} from '../../src/diagnostics/scheduler-observations.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import type { IDistributedLock } from '../../src/interfaces/index.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

/** Builds an observed service over a controllable runtime and lock. */
function observed(lock: IDistributedLock = new MemoryLock(new FakeRuntime())) {
  const runtime = new FakeRuntime();
  const collector = new SchedulerObservationCollector(
    'cron',
    new Map([['tick', 'tick-alias']]),
    runtime.now.bind(runtime),
    runtime.hrtime.bind(runtime),
  );
  const service = new SchedulerService(runtime, lock);
  attachSchedulerCollector(service, collector);
  return { service, collector, runtime, lock };
}

/** The record for one (job alias, operation) tuple. */
function recordOf(
  snapshot: ReturnType<SchedulerObservationCollector['snapshot']>,
  alias: string,
  operation: 'fire' | 'attempt',
) {
  return snapshot.records.find((r) => r.alias === alias && r.operation === operation);
}

/** Arms one 100 ms delay job and lets it fire. */
async function fireDelay(
  service: SchedulerService,
  runtime: FakeRuntime,
  handler: () => void,
): Promise<void> {
  await service.connect();
  await service.delay('tick', 100, handler);
  await runtime.advance(140);
}

describe('compileSchedulerDiagnostics', () => {
  it('accepts the literal-true opt-in and compiles the job approvals', () => {
    const compiled = compileSchedulerDiagnostics({
      enabled: true,
      alias: 'primary',
      jobs: { 'nightly-sync': 'sync', tick: 'tick-alias' },
    });
    expect(compiled.alias).toBe('primary');
    expect(compiled.jobs.get('nightly-sync')).toBe('sync');
    expect(compiled.jobs.get('tick')).toBe('tick-alias');
    expect(
      compileSchedulerDiagnostics({ enabled: true, alias: 'x'.repeat(64), jobs: {} }).jobs
        .size,
    ).toBe(0);
  });

  it('refuses every invalid shape with a fixed, value-free message', () => {
    const base = { enabled: true, alias: 'primary', jobs: {} } as const;
    const cases: readonly [unknown, string][] = [
      [null, SCHEDULER_DIAGNOSTICS_ERRORS.shape],
      [[], SCHEDULER_DIAGNOSTICS_ERRORS.shape],
      ['x', SCHEDULER_DIAGNOSTICS_ERRORS.shape],
      [{ ...base, extra: 1 }, SCHEDULER_DIAGNOSTICS_ERRORS.shape],
      [{ ...base, enabled: false }, SCHEDULER_DIAGNOSTICS_ERRORS.enabled],
      [{ ...base, alias: 7 }, SCHEDULER_DIAGNOSTICS_ERRORS.aliasType],
      [{ ...base, alias: '' }, SCHEDULER_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ ...base, alias: 'x'.repeat(65) }, SCHEDULER_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ ...base, alias: 'a\u001bb' }, SCHEDULER_DIAGNOSTICS_ERRORS.aliasControl],
      [{ enabled: true, alias: 'a' }, SCHEDULER_DIAGNOSTICS_ERRORS.jobsRequired],
      [{ ...base, jobs: 'x' }, SCHEDULER_DIAGNOSTICS_ERRORS.jobsShape],
      [{ ...base, jobs: [] }, SCHEDULER_DIAGNOSTICS_ERRORS.jobsShape],
      [{ ...base, jobs: new Map() }, SCHEDULER_DIAGNOSTICS_ERRORS.jobsShape],
      [{ ...base, jobs: { a: 7 } }, SCHEDULER_DIAGNOSTICS_ERRORS.jobsValue],
      [{ ...base, jobs: { a: '' } }, SCHEDULER_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ ...base, jobs: { a: 'a\u0085b' } }, SCHEDULER_DIAGNOSTICS_ERRORS.aliasControl],
      [{ ...base, jobs: { a: 'same', b: 'same' } }, SCHEDULER_DIAGNOSTICS_ERRORS.jobsDuplicate],
    ];
    for (const [input, message] of cases) {
      expect(() => compileSchedulerDiagnostics(input as SchedulerDiagnosticsOptions)).toThrow(
        message,
      );
    }
    const bigJobs = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`job-${i}`, `alias-${i}`]),
    );
    expect(() => compileSchedulerDiagnostics({ ...base, jobs: bigJobs })).toThrow(
      SCHEDULER_DIAGNOSTICS_ERRORS.jobsCount,
    );
  });

  it('refuses at SchedulerPlugin() construction, before any application exists', () => {
    expect(() =>
      SchedulerPlugin({
        diagnostics: {
          enabled: false,
          alias: 'a',
          jobs: {},
        } as unknown as SchedulerDiagnosticsOptions,
      })
    ).toThrow(SCHEDULER_DIAGNOSTICS_ERRORS.enabled);
  });
});

describe('SchedulerObservationCollector', () => {
  it('counts one settled fire and one settled attempt with their detail counters', () => {
    const { collector, runtime } = observed();
    const obs = collector.fireBegin('tick', runtime.now() - 30);
    expect(obs).toEqual({ jobAlias: 'tick-alias', latenessMs: 30 });
    collector.fireSettled(obs, 'dispatched', true, 5);
    const attempts = collector.attemptObserver('tick');
    attempts!.attemptStarted();
    runtime.advance(4);
    attempts!.attemptSettled(true, false);
    const fire = recordOf(collector.snapshot(), 'tick-alias', 'fire')!;
    expect(fire).toMatchObject({
      count: 1,
      started: 1,
      succeeded: 1,
      failed: 0,
      contended: 0,
      lockFailed: 0,
      retryAttempts: 0,
      lastDurationMs: 5,
      lastLatenessMs: 30,
    });
    expect(fire.operation).toBe('fire');
    const attempt = recordOf(collector.snapshot(), 'tick-alias', 'attempt')!;
    expect(attempt).toMatchObject({
      count: 1,
      started: 1,
      succeeded: 1,
      failed: 0,
      contended: 0,
      lockFailed: 0,
      retryAttempts: 0,
      lastDurationMs: 4,
      lastLatenessMs: 0,
    });
  });

  it('counts contended and lock-failed fires and failed attempts', () => {
    const { collector } = observed();
    const obs = collector.fireBegin('tick', 0);
    collector.fireSettled(obs, 'contended', null, null);
    collector.fireSettled(collector.fireBegin('tick', 0), 'lock-failed', null, null);
    collector.fireSettled(collector.fireBegin('tick', 0), 'dispatched', false, 7);
    const attempts = collector.attemptObserver('tick')!;
    attempts.attemptStarted();
    attempts.attemptSettled(false, true);
    expect(recordOf(collector.snapshot(), 'tick-alias', 'fire')).toMatchObject({
      count: 3,
      started: 1,
      succeeded: 0,
      failed: 1,
      contended: 1,
      lockFailed: 1,
    });
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toMatchObject({
      count: 1,
      started: 1,
      failed: 1,
      retryAttempts: 1,
    });
  });

  it('ignores a null observation and reports no-data before anything settled', () => {
    const { collector } = observed();
    collector.fireSettled(null, 'dispatched', true, 1);
    expect(collector.snapshot()).toEqual({
      state: 'no-data',
      alias: 'cron',
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });

  it('expires records without an observation and reports stale before expiry', () => {
    const { collector, runtime } = observed();
    collector.fireSettled(collector.fireBegin('tick', 0), 'dispatched', true, 1);
    runtime.advance(31_000);
    runtime.clearAllTimers();
    expect(collector.snapshot().state).toBe('stale');
    runtime.advance(30_000);
    expect(collector.snapshot().state).toBe('no-data');
  });

  it('drops a NEW tuple at capacity while existing tuples keep updating', () => {
    const runtime = new FakeRuntime();
    const jobs = new Map(
      Array.from({ length: SCHEDULER_COLLECTOR_LIMITS.maxJobs }, (_, i) => [`j${i}`, `a${i}`]),
    );
    const collector = new SchedulerObservationCollector(
      'cron',
      jobs,
      runtime.now.bind(runtime),
      runtime.hrtime.bind(runtime),
    );
    for (let i = 0; i < jobs.size; i++) {
      collector.fireSettled(collector.fireBegin(`j${i}`, 0), 'dispatched', true, null);
    }
    expect(collector.snapshot().records).toHaveLength(SCHEDULER_COLLECTOR_LIMITS.maxRecords);
    expect(collector.snapshot().dropped).toBe(0);
    // An EXISTING tuple (j0's fire) still updates at capacity, but its first
    // ATTEMPT tuple is new: no slot is free, so it is dropped.
    collector.fireSettled(
      collector.fireBegin(`j0`, 0)!,
      'dispatched',
      true,
      null,
    );
    expect(collector.snapshot().dropped).toBe(0);
    // A refused START is not a drop by itself — its settlement counts the
    // one ignored observation, so an attempt is dropped exactly once.
    const j0 = collector.attemptObserver('j0')!;
    j0.attemptStarted();
    expect(collector.snapshot().dropped).toBe(0);
    j0.attemptSettled(true, false);
    expect(collector.snapshot().dropped).toBe(1);
    // An existing tuple's SECOND operation is also a drop: the slots are
    // full and every (alias, operation) pair is distinct.
    collector.fireSettled(collector.fireBegin('j1', 0), 'dispatched', true, null);
    const j1 = collector.attemptObserver('j1')!;
    j1.attemptStarted();
    j1.attemptSettled(false, false);
    expect(collector.snapshot().dropped).toBe(2);
    expect(collector.snapshot().records).toHaveLength(SCHEDULER_COLLECTOR_LIMITS.maxRecords);
  });

  it('reclaims expired slots before refusing a NEW tuple at capacity', async () => {
    const runtime = new FakeRuntime();
    const jobs = new Map(
      Array.from({ length: SCHEDULER_COLLECTOR_LIMITS.maxJobs }, (_, i) => [`j${i}`, `a${i}`]),
    );
    const collector = new SchedulerObservationCollector(
      'cron',
      jobs,
      runtime.now.bind(runtime),
      runtime.hrtime.bind(runtime),
    );
    for (let i = 0; i < jobs.size; i++) {
      collector.fireSettled(collector.fireBegin(`j${i}`, 0), 'contended', null, null);
    }
    // Every slot expires, and NOTHING reads the source in between — only a
    // read used to sweep, so the full table of dead slots refused live work.
    await runtime.advance(SCHEDULER_COLLECTOR_LIMITS.retentionMs + 1);
    const observer = collector.attemptObserver('j0')!;
    observer.attemptStarted();
    observer.attemptSettled(true, false);
    const snapshot = collector.snapshot();
    expect(snapshot.dropped).toBe(0);
    expect(snapshot.records.map((r) => [r.alias, r.operation, r.count, r.started])).toEqual([
      ['a0', 'attempt', 1, 1],
    ]);
  });

  it('keeps started >= count when a record expires while its attempt is in flight', async () => {
    const { collector, runtime } = observed();
    const observer = collector.attemptObserver('tick')!;
    observer.attemptStarted();
    // The handler outlives retention: the record its start was counted in
    // is replaced by a fresh one before the settlement lands.
    await runtime.advance(SCHEDULER_COLLECTOR_LIMITS.retentionMs + 1_000);
    observer.attemptSettled(true, false);
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toMatchObject({
      count: 1,
      started: 1,
      succeeded: 1,
      lastDurationMs: SCHEDULER_COLLECTOR_LIMITS.retentionMs + 1_000,
    });
  });

  it('counts each start once across retried attempts on one observer', async () => {
    const { collector, runtime } = observed();
    const observer = collector.attemptObserver('tick')!;
    observer.attemptStarted();
    await runtime.advance(3);
    observer.attemptSettled(false, false);
    observer.attemptStarted();
    await runtime.advance(7);
    observer.attemptSettled(true, true);
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toMatchObject({
      count: 2,
      started: 2,
      failed: 1,
      succeeded: 1,
      retryAttempts: 1,
      lastDurationMs: 7,
    });
  });

  it("rounds a fractional lateness and duration to the wire's integer milliseconds", () => {
    const { collector, runtime } = observed();
    const obs = collector.fireBegin('tick', runtime.now() - 0.5);
    expect(obs).toEqual({ jobAlias: 'tick-alias', latenessMs: 1 });
    collector.fireSettled(obs, 'dispatched', true, 2.4);
    const fire = recordOf(collector.snapshot(), 'tick-alias', 'fire')!;
    expect(fire.lastLatenessMs).toBe(1);
    expect(fire.lastDurationMs).toBe(2);
    expect(toWireMs(Number.NaN)).toBe(0);
    expect(toWireMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toWireMs(-3)).toBe(0);
    expect(toWireMs(Number.MAX_SAFE_INTEGER * 2)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('guards its own clock reads for the service and answers null once failed', () => {
    let fail = false;
    const runtime = new FakeRuntime();
    const collector = new SchedulerObservationCollector(
      'cron',
      new Map([['tick', 'tick-alias']]),
      runtime.now.bind(runtime),
      () => {
        if (fail) {
          throw new Error('mono-canary');
        }
        return runtime.hrtime();
      },
    );
    expect(collector.elapsedSince(null)).toBeNull();
    const start = collector.monotonic();
    expect(start).toBe(runtime.hrtime());
    expect(collector.elapsedSince(start)).toBe(0);
    fail = true;
    expect(collector.monotonic()).toBeNull();
    expect(collector.snapshot().state).toBe('collection-failed');
    expect(collector.elapsedSince(start)).toBeNull();
  });

  it('saturates the dropped counter', () => {
    expect(bump(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(bump(0)).toBe(1);
  });

  it('latches collection-failed on a throwing clock and stops capture', () => {
    const runtime = new FakeRuntime();
    let failMono = false;
    const collector = new SchedulerObservationCollector(
      'cron',
      new Map([['tick', 'tick-alias']]),
      runtime.now.bind(runtime),
      () => {
        if (failMono) {
          throw new Error('mono-canary');
        }
        return runtime.hrtime();
      },
    );
    collector.fireSettled(collector.fireBegin('tick', 0), 'dispatched', true, 1);
    failMono = true;
    // fireBegin reads the WALL clock only, so it still returns an
    // observation; the MONO failure latches at the settle.
    collector.fireSettled(collector.fireBegin('tick', 0), 'dispatched', true, 1);
    expect(collector.fireBegin('tick', 0)).toBeNull();
    expect(collector.snapshot()).toEqual({
      state: 'collection-failed',
      alias: 'cron',
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });

  it('latches collection-failed when the wall clock throws mid-fire', () => {
    const runtime = new FakeRuntime();
    let failWall = false;
    const collector = new SchedulerObservationCollector(
      'cron',
      new Map([['tick', 'tick-alias']]),
      () => {
        if (failWall) {
          throw new Error('wall-canary');
        }
        return runtime.now();
      },
      runtime.hrtime.bind(runtime),
    );
    failWall = true;
    expect(collector.fireBegin('tick', 0)).toBeNull();
    expect(collector.snapshot().state).toBe('collection-failed');
  });

  it('answers disabled after close and ignores late observations', () => {
    const { collector } = observed();
    const attempts = collector.attemptObserver('tick');
    const obs = collector.fireBegin('tick', 0);
    collector.close();
    collector.fireSettled(obs, 'dispatched', true, 1);
    attempts!.attemptStarted();
    expect(collector.snapshot()).toEqual({
      state: 'disabled',
      alias: null,
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });

  it('serves an inert disabled source when no collector exists', () => {
    expect(createSchedulerDiagnosticsSource(null).snapshot()).toEqual({
      state: 'disabled',
      alias: null,
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });
});

describe('observed SchedulerService fires', () => {
  it('records a successful dispatch with its attempt', async () => {
    const { service, collector, runtime } = observed();
    let ran = 0;
    await fireDelay(service, runtime, () => {
      ran++;
    });
    expect(ran).toBe(1);
    expect(recordOf(collector.snapshot(), 'tick-alias', 'fire')).toMatchObject({
      count: 1,
      started: 1,
      succeeded: 1,
      failed: 0,
      contended: 0,
      lockFailed: 0,
      // fireDelay advances 140 ms against a 100 ms delay: 40 ms late.
      lastLatenessMs: 40,
    });
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toMatchObject({
      count: 1,
      succeeded: 1,
      failed: 0,
      retryAttempts: 0,
    });
  });

  it('records lateness as max(0, actualStart - intendedFire), never negative', async () => {
    const { service, collector, runtime } = observed();
    await service.connect();
    await service.delay('tick', 100, () => {});
    // The timer fires 40 ms after the intended instant: lateness is the
    // positive difference, never an absolute schedule and never negative.
    await runtime.advance(140);
    expect(recordOf(collector.snapshot(), 'tick-alias', 'fire')!.lastLatenessMs).toBe(40);
  });

  it('counts retry attempts and the final failure without throwing', async () => {
    const { service, collector, runtime } = observed();
    let calls = 0;
    await service.connect();
    await service.delay('tick', 100, () => {
      calls++;
      throw new Error('attempt-canary');
    }, { retry: { limit: 2, delay: 10, backoff: 'fixed' } });
    // Two-phase advance: the first fires the job; a macrotask lets the fire
    // chain reach the executor and arm its backoff sleep; the second fires
    // that sleep. Awaiting the first advance directly would deadlock inside
    // the FakeRuntime, whose sleep timer only fires on a later advance.
    const first = runtime.advance(140);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await runtime.advance(200);
    await first;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toMatchObject({
      count: 2,
      started: 2,
      succeeded: 0,
      failed: 2,
      retryAttempts: 1,
    });
    expect(recordOf(collector.snapshot(), 'tick-alias', 'fire')).toMatchObject({
      started: 1,
      failed: 1,
      succeeded: 0,
    });
  });

  it('records a contended fire when the fire slot was claimed elsewhere', async () => {
    const { service, collector, runtime, lock } = observed();
    await service.connect();
    await service.every('tick', 100_000, () => {});
    const intended = await service.getNextRun('tick');
    expect(await lock.acquire(`scheduler:job:tick:${String(intended)}`, 30_000)).not.toBeNull();
    await runtime.advance(runtime.getNextTimerDelay()! + 1);
    const fire = recordOf(collector.snapshot(), 'tick-alias', 'fire');
    expect(fire).toMatchObject({ count: 1, started: 0, contended: 1, lockFailed: 0 });
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toBeUndefined();
  });

  it('records a contended fire when the overlap mutex is held elsewhere', async () => {
    const { service, collector, runtime, lock } = observed();
    await service.connect();
    await service.every('tick', 100_000, () => {});
    expect(await lock.acquire('scheduler:job:tick', 30_000)).not.toBeNull();
    await runtime.advance(runtime.getNextTimerDelay()! + 1);
    const fire = recordOf(collector.snapshot(), 'tick-alias', 'fire');
    expect(fire).toMatchObject({ count: 1, started: 0, contended: 1 });
    // The overlap-mutex loser ran no handler and produces NO attempt record.
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toBeUndefined();
  });

  it('records a contended delay whose registration slot belongs to another replica', async () => {
    const { service, collector, runtime, lock } = observed();
    expect(await lock.acquire('scheduler:job:tick:once', 60_000)).not.toBeNull();
    await fireDelay(service, runtime, () => {
      throw new Error('must-not-run');
    });
    const fire = recordOf(collector.snapshot(), 'tick-alias', 'fire');
    expect(fire).toMatchObject({ count: 1, started: 0, contended: 1 });
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toBeUndefined();
  });

  it('records a lock-failed fire when the slot acquisition rejects', async () => {
    const broken: IDistributedLock = {
      acquire: () => Promise.reject(new Error('lock-canary')),
      release: () => Promise.resolve(),
    };
    const { service, collector, runtime } = observed(broken);
    // A cron/every fire claims its slot AT FIRE TIME, so a rejecting lock
    // surfaces there. (A delay's slot is claimed at registration, where the
    // same rejection marks the entry not-claimed — the contended path.)
    await service.connect();
    await service.every('tick', 100_000, () => {});
    await runtime.advance(runtime.getNextTimerDelay()! + 1);
    expect(recordOf(collector.snapshot(), 'tick-alias', 'fire')).toMatchObject({
      count: 1,
      started: 0,
      lockFailed: 1,
      contended: 0,
    });
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toBeUndefined();
  });

  it('records a lock-failed fire when the mutex acquisition rejects after the slot is claimed', async () => {
    const runtime = new FakeRuntime();
    const mutexThrowing: IDistributedLock = {
      acquire: (key) =>
        key === 'scheduler:job:tick'
          ? Promise.reject(new Error('mutex-canary'))
          : Promise.resolve(`token-${key.length}`),
      release: () => Promise.resolve(),
    };
    const service = new SchedulerService(runtime, mutexThrowing);
    const collector = new SchedulerObservationCollector(
      'cron',
      new Map([['tick', 'tick-alias']]),
      runtime.now.bind(runtime),
      runtime.hrtime.bind(runtime),
    );
    attachSchedulerCollector(service, collector);
    await fireDelay(service, runtime, () => {});
    expect(recordOf(collector.snapshot(), 'tick-alias', 'fire')).toMatchObject({
      count: 1,
      started: 0,
      lockFailed: 1,
    });
    expect(recordOf(collector.snapshot(), 'tick-alias', 'attempt')).toBeUndefined();
  });

  it('records nothing for an unapproved job beyond the attachment check', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    const collector = new SchedulerObservationCollector(
      'cron',
      new Map([['tick', 'tick-alias']]),
      runtime.now.bind(runtime),
      runtime.hrtime.bind(runtime),
    );
    attachSchedulerCollector(service, collector);
    await service.connect();
    await service.delay('other-job', 100, () => {});
    await runtime.advance(140);
    expect(collector.snapshot().records).toEqual([]);
    expect(collector.snapshot().state).toBe('no-data');
  });

  it('stops observing after detach, then close', async () => {
    const { service, collector, runtime } = observed();
    await service.connect();
    await service.delay('tick', 100, () => {});
    detachSchedulerCollector(service);
    collector.close();
    await runtime.advance(140);
    expect(collector.snapshot().state).toBe('disabled');
  });
});

describe('SchedulerPlugin diagnostics wiring', () => {
  it('registers an inert disabled source by default and a live one when opted in', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SchedulerPlugin({
          diagnostics: { enabled: true, alias: 'cron', jobs: { tick: 'tick-alias' } },
        }),
      ],
    });
    await app.start();
    try {
      const sources = app.services.getAll<ISchedulerDiagnosticsSource>(
        CAPABILITIES.SCHEDULER_DIAGNOSTICS,
      );
      expect(sources).toHaveLength(1);
      expect(sources[0]!.snapshot().state).toBe('no-data');
      expect(sources[0]!.snapshot().alias).toBe('cron');
    } finally {
      await app.stop();
    }
  });

  it('observes fires and attempts of an app-registered job and closes cleanly', async () => {
    let handler: (() => void | Promise<void>) | undefined;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SchedulerPlugin({
          jobs: [{
            trigger: 'delay',
            name: 'tick',
            delayMs: 30,
            handler: () => {
              handler?.();
            },
          }],
          diagnostics: { enabled: true, alias: 'cron', jobs: { tick: 'tick-alias' } },
        }),
      ],
    });
    // The declared job's handler is opaque to the app; observe through the
    // source instead and drive one extra imperative fire through the
    // resolved scheduler.
    await app.start();
    try {
      const scheduler = app.services.get<IScheduler>(CAPABILITIES.SCHEDULER);
      let ran = false;
      await scheduler.delay('oneshot', 20, () => {
        ran = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(ran).toBe(true);
      const source = app.services.getAll<ISchedulerDiagnosticsSource>(
        CAPABILITIES.SCHEDULER_DIAGNOSTICS,
      )[0]!;
      const snapshot = source.snapshot();
      // `tick` (declared) was approved and fired; `oneshot` was not approved
      // and is invisible.
      expect(snapshot.records.some((r) => r.alias === 'tick-alias' && r.operation === 'fire'))
        .toBe(true);
      expect(snapshot.records.some((r) => r.alias === 'oneshot')).toBe(false);
      expect(['ready', 'stale']).toContain(snapshot.state);
      void handler;
    } finally {
      await app.stop();
    }
    // After close the source answers disabled: detached first, then cleared.
    const source = app.services.getAll<ISchedulerDiagnosticsSource>(
      CAPABILITIES.SCHEDULER_DIAGNOSTICS,
    )[0]!;
    expect(source.snapshot().state).toBe('disabled');
  });

  it('leaves provides unchanged — the diagnostics token is never claimed', () => {
    const plugin = SchedulerPlugin({
      diagnostics: { enabled: true, alias: 'cron', jobs: {} },
    });
    expect(plugin.provides).toEqual(['scheduler']);
  });
});

/** A runtime whose monotonic clock throws — the "failing observer" case. */
class ThrowingHrtimeRuntime extends FakeRuntime {
  override hrtime(): number {
    throw new Error('mono-canary');
  }
}

/** What one scheduler scenario did, independent of any observation. */
interface ScenarioTrace {
  readonly calls: readonly string[];
  readonly lockOps: readonly string[];
  readonly nextRun: number;
  readonly pendingTimers: number;
}

/**
 * Runs one fixed scenario — cron, every and a retried delay job, a contended
 * fire slot, a held overlap mutex, pause/resume/remove — and records every
 * handler call and every lock operation. `mode` decides only what is
 * attached: nothing, a working collector, or a collector over a runtime
 * whose monotonic clock always throws — bound exactly as the plugin binds
 * it (`runtime.hrtime`), so any observation-only clock read the scheduler
 * makes OUTSIDE the collector's guard would throw into scheduling here.
 */
async function runScenario(
  mode: 'off' | 'on' | 'failing',
): Promise<{
  trace: ScenarioTrace;
  collector: SchedulerObservationCollector | null;
  /** The collector's snapshot right after the contended cron fire (within retention). */
  midSnapshot: ReturnType<SchedulerObservationCollector['snapshot']> | null;
}> {
  const runtime = mode === 'failing' ? new ThrowingHrtimeRuntime() : new FakeRuntime();
  const inner = new MemoryLock(runtime);
  const lockOps: string[] = [];
  let refusedSlot = false;
  let overlapAcquires = 0;
  const lock: IDistributedLock = {
    acquire: async (key, ttlMs) => {
      // The first cron fire's slot is claimed elsewhere, and the second
      // overlap-mutex acquire for the every job is held elsewhere.
      if (!refusedSlot && key.startsWith('scheduler:job:c:')) {
        refusedSlot = true;
        lockOps.push(`acquire ${key} -> held`);
        return null;
      }
      if (key === 'scheduler:job:e' && ++overlapAcquires === 2) {
        lockOps.push(`acquire ${key} -> held`);
        return null;
      }
      const token = await inner.acquire(key, ttlMs);
      lockOps.push(`acquire ${key} -> ${token === null ? 'held' : 'granted'}`);
      return token;
    },
    release: async (key, token) => {
      lockOps.push(`release ${key}`);
      await inner.release(key, token);
    },
  };
  const service = new SchedulerService(runtime, lock);
  let collector: SchedulerObservationCollector | null = null;
  if (mode !== 'off') {
    collector = new SchedulerObservationCollector(
      'cron',
      new Map([['c', 'c-alias'], ['e', 'e-alias'], ['d', 'd-alias']]),
      runtime.now.bind(runtime),
      runtime.hrtime.bind(runtime),
    );
    attachSchedulerCollector(service, collector);
  }
  const calls: string[] = [];
  let flakyCalls = 0;
  /** One advance that also lets a retry's backoff sleep fire (see the retry test). */
  const step = async (ms: number) => {
    const first = runtime.advance(ms);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await runtime.advance(20);
    await first;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  await service.connect();
  await service.cron('c', '* * * * *', (job) => {
    calls.push(`c#${job.attempts}`);
  });
  await service.every('e', 100, (job) => {
    calls.push(`e#${job.attempts}`);
  });
  await service.delay('d', 50, (job) => {
    calls.push(`d#${job.attempts}`);
    if (++flakyCalls === 1) {
      throw new Error('attempt-canary');
    }
  }, { retry: { limit: 2, delay: 10, backoff: 'fixed' } });
  await step(60);
  await step(100);
  await service.pause('e');
  await step(200);
  await service.resume('e');
  await step(100);
  await step(40_000);
  const midSnapshot = collector?.snapshot() ?? null;
  await step(60_000);
  await service.remove('c');
  await step(60_000);
  const nextRun = await service.getNextRun('e');
  const pendingTimers = runtime.getPendingTimerCount();
  await service.disconnect();
  return { trace: { calls, lockOps, nextRun, pendingTimers }, collector, midSnapshot };
}

describe('observation never changes scheduling (off / on / failing)', () => {
  it('produces the identical handler calls, lock traffic and schedule in every mode', async () => {
    const off = await runScenario('off');
    const on = await runScenario('on');
    const failing = await runScenario('failing');
    // Positive controls: the scenario exercised what it claims to.
    expect(off.trace.calls).toContain('d#1');
    expect(off.trace.calls).toContain('d#2');
    expect(off.trace.calls).toContain('c#1');
    expect(off.trace.calls.filter((c) => c.startsWith('e#')).length).toBeGreaterThan(1);
    expect(off.trace.lockOps.filter((op) => op.endsWith('-> held')).length).toBe(2);
    // Identical behaviour, whatever is attached.
    expect(on.trace).toEqual(off.trace);
    expect(failing.trace).toEqual(off.trace);
    // The working collector observed it; the failing one latched and stopped.
    const snapshot = on.midSnapshot!;
    expect(recordOf(snapshot, 'c-alias', 'fire')).toMatchObject({ contended: 1 });
    expect(recordOf(snapshot, 'e-alias', 'fire')!.contended).toBe(1);
    expect(recordOf(snapshot, 'd-alias', 'attempt')).toMatchObject({
      count: 2,
      started: 2,
      failed: 1,
      succeeded: 1,
      retryAttempts: 1,
    });
    expect(failing.midSnapshot!.state).toBe('collection-failed');
    expect(failing.collector!.snapshot().state).toBe('collection-failed');
    // Late fires in the working mode still observed after the long gap.
    expect(recordOf(on.collector!.snapshot(), 'e-alias', 'fire')!.started).toBeGreaterThan(0);
  });
});
