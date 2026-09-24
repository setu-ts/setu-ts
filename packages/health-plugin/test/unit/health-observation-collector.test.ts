/**
 * Unit tests for the health-observation collector (M98d): the latest-only
 * retention seam, the bounded scheduler, the minimized snapshot, and the
 * 256 KiB budget. A mutable clock drives monotonic time and timers so the
 * stale/timeout/scheduling paths are deterministic. No indicator `data`,
 * error text, unrecognized status, or absolute time is ever accepted or
 * projected. Option validation lives in `health-observation-options.test.ts`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HealthCheckResult, IRuntimeServices, TimerHandle } from '@setu-ts/common';
import {
  applyHealthSnapshotBudget,
  COLLECTOR_ERRORS,
  compileHealthDiagnosticsPolicy,
  type HealthIndicatorRunner,
  HealthObservationCollector,
} from '../../src/diagnostics/health-observation-collector.ts';
import type { HealthDiagnosticsOptions } from '../../src/interfaces/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const INSTANCE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

interface FakeTimer {
  at: number;
  readonly fn: () => void;
  /** Re-arm period for an interval; `null` for a one-shot timeout. */
  readonly every: number | null;
}

/**
 * A mutable monotonic clock with controllable timers, built on the shared
 * fake runtime. `advance` moves the clock and fires due timers in order; an
 * interval RE-ARMS after firing, as a real `setInterval` does.
 *
 * @internal
 */
class MutableRuntime {
  /** The runtime view the collector receives: monotonic clock + timers. */
  readonly runtime: IRuntimeServices;
  #hr = 0;
  #timers = new Map<TimerHandle, FakeTimer>();
  #nextHandle = 1;

  constructor() {
    const base = createFakeRuntime({ hrtime: 0 });
    this.runtime = {
      ...base,
      hrtime: () => this.#hr,
      setTimeout: (fn: () => void, ms: number) => this.#add(fn, ms, null),
      clearTimeout: (handle: TimerHandle) => {
        this.#timers.delete(handle);
      },
      setInterval: (fn: () => void, ms: number) => this.#add(fn, ms, ms),
      clearInterval: (handle: TimerHandle) => {
        this.#timers.delete(handle);
      },
    };
  }

  /** The number of armed timers (timeouts plus intervals). */
  get armed(): number {
    return this.#timers.size;
  }

  #add(fn: () => void, ms: number, every: number | null): TimerHandle {
    const handle = this.#nextHandle++ as TimerHandle;
    this.#timers.set(handle, { at: this.#hr + ms, fn, every });
    return handle;
  }

  /** Advances the clock to `toMs`, firing any timers that come due. */
  advance(toMs: number): void {
    while (this.#hr < toMs) {
      let due: TimerHandle | undefined;
      let soonest = Infinity;
      for (const [handle, timer] of this.#timers) {
        if (timer.at <= toMs && timer.at < soonest) {
          soonest = timer.at;
          due = handle;
        }
      }
      if (due === undefined) {
        this.#hr = toMs;
        break;
      }
      this.#hr = soonest;
      const timer = this.#timers.get(due)!;
      if (timer.every === null) {
        this.#timers.delete(due);
      } else {
        timer.at += timer.every;
      }
      timer.fn();
    }
  }
}

/** Drains every pending microtask (one real macrotask turn). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Advances the fake clock in `stepMs` increments, draining microtasks between steps. */
async function advanceBy(clock: MutableRuntime, fromMs: number, toMs: number, stepMs: number) {
  for (let at = fromMs + stepMs; at <= toMs; at += stepMs) {
    clock.advance(at);
    await flush();
  }
}

/** A runner that returns a controllable promise per indicator name, counting calls. */
function makeRunner(
  results: Record<string, () => Promise<HealthCheckResult>>,
  calls: Record<string, number> = {},
): HealthIndicatorRunner {
  return {
    run(name: string): Promise<HealthCheckResult> | null {
      const result = results[name];
      if (result === undefined) {
        return null;
      }
      calls[name] = (calls[name] ?? 0) + 1;
      return result();
    },
  };
}

const up = (): Promise<HealthCheckResult> =>
  Promise.resolve({ status: 'up', data: { secret: 'canary-data' } });
const fail = (): Promise<HealthCheckResult> => Promise.reject(new Error('canary-error-text'));
const hang = (): Promise<HealthCheckResult> => new Promise<HealthCheckResult>(() => {});

function options(overrides: Partial<HealthDiagnosticsOptions> = {}): HealthDiagnosticsOptions {
  return {
    enabled: true,
    indicators: { 'db.check': 'database', 'cache.check': 'cache' },
    ...overrides,
  };
}

/** Builds a collector through the ONE option validator the plugin uses. */
function collectorFor(
  opts: HealthDiagnosticsOptions,
  runtime: IRuntimeServices,
  runner: HealthIndicatorRunner,
): HealthObservationCollector {
  return new HealthObservationCollector(compileHealthDiagnosticsPolicy(opts), runtime, runner);
}

describe('Collector — retention seam', () => {
  it('retains the latest outcome per approved alias and counts unapproved as dropped', () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(options(), clock.runtime, makeRunner({}));
    collector.report('db.check', { state: 'reported', status: 'up', latencyMs: 3 }, 'application');
    collector.report(
      'db.check',
      { state: 'reported', status: 'down', latencyMs: 9 },
      'application',
    );
    collector.report(
      'unapproved',
      { state: 'reported', status: 'up', latencyMs: 1 },
      'application',
    );

    const snapshot = collector.snapshot(INSTANCE);
    // Latest-only: the second report replaced the first.
    const database = snapshot.observations.find((o) => o.indicatorAlias === 'database')!;
    expect(database.state).toBe('reported');
    expect(database.status).toBe('down');
    expect(database.latencyMs).toBe(9);
    // The unapproved name was counted as dropped, never retained.
    expect(snapshot.droppedObservations).toBe(1);
    expect(snapshot.observations.some((o) => o.indicatorAlias === 'unapproved')).toBe(false);
  });

  it('projects a never-observed alias with null latency and age', () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(options(), clock.runtime, makeRunner({}));
    const snapshot = collector.snapshot(INSTANCE);
    const cache = snapshot.observations.find((o) => o.indicatorAlias === 'cache')!;
    expect(cache.state).toBe('never-observed');
    expect(cache.latencyMs).toBeNull();
    expect(cache.ageMs).toBeNull();
    expect('status' in cache).toBe(false);
  });

  it('reports the inspector state from data freshness: no-data, ready, stale', () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(
      options({ staleAfterMs: 1000 }),
      clock.runtime,
      makeRunner({}),
    );
    expect(collector.snapshot(INSTANCE).state).toBe('no-data');

    collector.report('db.check', { state: 'reported', status: 'up', latencyMs: 3 }, 'application');
    expect(collector.snapshot(INSTANCE).state).toBe('ready');

    clock.advance(1001);
    expect(collector.snapshot(INSTANCE).state).toBe('stale');
  });

  it('discards a report after close', () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(options(), clock.runtime, makeRunner({}));
    collector.close();
    collector.report('db.check', { state: 'reported', status: 'up', latencyMs: 3 }, 'application');
    const snapshot = collector.snapshot(INSTANCE);
    expect(snapshot.observations.every((o) => o.state === 'never-observed')).toBe(true);
  });

  it('refuses an empty instance identifier', () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(options(), clock.runtime, makeRunner({}));
    expect(() => collector.snapshot('')).toThrow(COLLECTOR_ERRORS.badInstanceId);
  });

  it('returns a frozen snapshot', () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(options(), clock.runtime, makeRunner({}));
    collector.report('db.check', { state: 'reported', status: 'up', latencyMs: 3 }, 'application');
    const snapshot = collector.snapshot(INSTANCE);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.observations)).toBe(true);
  });
});

describe('Collector — untrusted status', () => {
  it('retains a reported check with an unknown status as failed, dropping the value', () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(options(), clock.runtime, makeRunner({}));
    collector.report(
      'db.check',
      { state: 'reported', status: 'canary-status-token', latencyMs: 3 },
      'application',
    );
    const snapshot = collector.snapshot(INSTANCE);
    const database = snapshot.observations.find((o) => o.indicatorAlias === 'database')!;
    expect(database.state).toBe('failed');
    expect('status' in database).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('canary-status-token');
  });

  it('never carries a status on a non-reported state', () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(options(), clock.runtime, makeRunner({}));
    collector.report('db.check', { state: 'timed-out', status: 'up', latencyMs: 3 }, 'application');
    const database = collector.snapshot(INSTANCE).observations[0];
    expect(database.state).toBe('timed-out');
    expect('status' in database).toBe(false);
  });
});

describe('Collector — bounded scheduler', () => {
  const scheduled = (
    indicators: readonly string[],
    extra: { timeoutMs?: number; concurrency?: number } = {},
  ) => ({
    indicators,
    intervalMs: 1000,
    timeoutMs: extra.timeoutMs ?? 50,
    concurrency: extra.concurrency ?? 1,
  });

  it('reports a scheduled check as reported with the framework status', async () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(
      options({ indicators: { 'db.check': 'database' }, scheduled: scheduled(['db.check']) }),
      clock.runtime,
      makeRunner({ 'db.check': up }),
    );
    collector.startScheduled();
    await flush();
    const snapshot = collector.snapshot(INSTANCE);
    const database = snapshot.observations[0];
    expect(database.state).toBe('reported');
    expect(database.status).toBe('up');
    expect(database.origin).toBe('scheduled');
    expect(JSON.stringify(snapshot)).not.toContain('canary-data');
    collector.close();
  });

  it('reports a rejecting check as failed without leaking error text', async () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(
      options({ indicators: { 'db.check': 'database' }, scheduled: scheduled(['db.check']) }),
      clock.runtime,
      makeRunner({ 'db.check': fail }),
    );
    collector.startScheduled();
    await flush();
    const snapshot = collector.snapshot(INSTANCE);
    expect(snapshot.observations[0].state).toBe('failed');
    expect(JSON.stringify(snapshot)).not.toContain('canary-error-text');
    collector.close();
  });

  it('reports an unknown status, a null result, or a throwing getter as failed', async () => {
    const clock = new MutableRuntime();
    const throwingGetter = {
      get status(): string {
        throw new Error('canary-getter');
      },
      data: {},
    };
    const collector = collectorFor(
      options({
        indicators: { a: 'alpha', b: 'beta', c: 'gamma' },
        scheduled: scheduled(['a', 'b', 'c']),
      }),
      clock.runtime,
      makeRunner({
        a: () => Promise.resolve({ status: 'canary-status', data: {} } as never),
        b: () => Promise.resolve(null as never),
        c: () => Promise.resolve(throwingGetter as never),
      }),
    );
    collector.startScheduled();
    await flush();
    const snapshot = collector.snapshot(INSTANCE);
    expect(snapshot.observations.map((o) => [o.state, 'status' in o])).toEqual([
      ['failed', false],
      ['failed', false],
      ['failed', false],
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('canary');
    collector.close();
  });

  it('reports a runner that throws synchronously as failed', async () => {
    const clock = new MutableRuntime();
    const collector = collectorFor(
      options({ indicators: { 'db.check': 'database' }, scheduled: scheduled(['db.check']) }),
      clock.runtime,
      {
        run(): Promise<HealthCheckResult> {
          throw new Error('canary-sync');
        },
      },
    );
    collector.startScheduled();
    await flush();
    expect(collector.snapshot(INSTANCE).observations[0].state).toBe('failed');
    collector.close();
  });

  it('checks EVERY scheduled indicator each cycle, not only the first `concurrency`', async () => {
    const clock = new MutableRuntime();
    const calls: Record<string, number> = {};
    const collector = collectorFor(
      options({
        indicators: { a: 'alpha', b: 'beta', c: 'gamma' },
        scheduled: scheduled(['a', 'b', 'c'], { concurrency: 1 }),
      }),
      clock.runtime,
      makeRunner({ a: up, b: up, c: up }, calls),
    );
    collector.startScheduled();
    await flush();
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
    await advanceBy(clock, 0, 2000, 1000);
    expect(calls).toEqual({ a: 3, b: 3, c: 3 });
    expect(collector.snapshot(INSTANCE).observations.map((o) => o.state)).toEqual([
      'reported',
      'reported',
      'reported',
    ]);
    collector.close();
  });

  it('keeps refreshing healthy indicators while another one hangs', async () => {
    const clock = new MutableRuntime();
    const calls: Record<string, number> = {};
    const collector = collectorFor(
      options({
        indicators: { hung: 'hung', ok: 'ok' },
        staleAfterMs: 1500,
        scheduled: scheduled(['hung', 'ok'], { concurrency: 2, timeoutMs: 50 }),
      }),
      clock.runtime,
      makeRunner({ hung: hang, ok: up }, calls),
    );
    collector.startScheduled();
    await flush();
    await advanceBy(clock, 0, 4000, 50);
    // The hung callback holds its own slot and is never replaced; the healthy
    // indicator runs on every cycle: t = 0, 1000, 2000, 3000, 4000.
    expect(calls).toEqual({ hung: 1, ok: 5 });
    const snapshot = collector.snapshot(INSTANCE);
    const [hung, ok] = snapshot.observations;
    expect(hung.state).toBe('timed-out');
    expect(ok.state).toBe('reported');
    expect(ok.ageMs).toBe(0);
    collector.close();
  });

  it('counts an unsettled callback against the cap and resumes it only after it settles', async () => {
    const clock = new MutableRuntime();
    const calls: Record<string, number> = {};
    const pending: Record<string, (result: HealthCheckResult) => void> = {};
    const deferred = (name: string) => (): Promise<HealthCheckResult> =>
      new Promise<HealthCheckResult>((resolve) => {
        pending[name] = resolve;
      });
    const collector = collectorFor(
      options({
        indicators: { a: 'alpha', b: 'beta', c: 'gamma' },
        scheduled: scheduled(['a', 'b', 'c'], { concurrency: 1, timeoutMs: 10 }),
      }),
      clock.runtime,
      makeRunner({ a: deferred('a'), b: up, c: up }, calls),
    );
    collector.startScheduled();
    await flush();
    await advanceBy(clock, 0, 3000, 10);
    // `a` timed out for reporting but never settled: with one slot there is
    // no capacity, so no replacement for `a` and no other work starts.
    expect(calls).toEqual({ a: 1 });
    expect(collector.snapshot(INSTANCE).observations[0].state).toBe('timed-out');

    pending.a({ status: 'up', data: {} });
    await flush();
    await advanceBy(clock, 3000, 4000, 10);
    // The slot is free again and the rotation cursor starts after `a`, so
    // `b` and `c` run first, then `a` is re-run.
    expect(calls).toEqual({ a: 2, b: 1, c: 1 });
    collector.close();
  });

  it('never runs more callbacks at once than the concurrency cap', async () => {
    const clock = new MutableRuntime();
    let running = 0;
    let maxRunning = 0;
    const slow = (): Promise<HealthCheckResult> =>
      new Promise<HealthCheckResult>((resolve) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        clock.runtime.setTimeout(() => {
          running -= 1;
          resolve({ status: 'up', data: {} });
        }, 200);
      });
    const calls: Record<string, number> = {};
    const collector = collectorFor(
      options({
        indicators: { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' },
        scheduled: scheduled(['a', 'b', 'c', 'd', 'e'], { concurrency: 2, timeoutMs: 50 }),
      }),
      clock.runtime,
      makeRunner({ a: slow, b: slow, c: slow, d: slow, e: slow }, calls),
    );
    collector.startScheduled();
    await flush();
    await advanceBy(clock, 0, 3000, 10);
    expect(maxRunning).toBe(2);
    // Every indicator is reached across cycles despite each one outliving
    // its reporting deadline.
    expect(Object.keys(calls).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    collector.close();
  });

  it('skips an approved name with no registered indicator, leaving it never-observed', async () => {
    const clock = new MutableRuntime();
    const calls: Record<string, number> = {};
    const collector = collectorFor(
      options({
        indicators: { ghost: 'ghost', ok: 'ok' },
        scheduled: scheduled(['ghost', 'ok']),
      }),
      clock.runtime,
      makeRunner({ ok: up }, calls),
    );
    collector.startScheduled();
    await flush();
    expect(calls).toEqual({ ok: 1 });
    expect(collector.snapshot(INSTANCE).observations.map((o) => o.state)).toEqual([
      'never-observed',
      'reported',
    ]);
    collector.close();
  });

  it('starts once, and never without a schedule or after close', async () => {
    const clock = new MutableRuntime();
    const calls: Record<string, number> = {};
    const unscheduled = collectorFor(options(), clock.runtime, makeRunner({}, calls));
    unscheduled.startScheduled();
    expect(clock.armed).toBe(0);

    const collector = collectorFor(
      options({ indicators: { a: 'a' }, scheduled: scheduled(['a']) }),
      clock.runtime,
      makeRunner({ a: up }, calls),
    );
    collector.startScheduled();
    collector.startScheduled();
    await flush();
    expect(calls).toEqual({ a: 1 });
    collector.close();

    const closed = collectorFor(
      options({ indicators: { a: 'a' }, scheduled: scheduled(['a']) }),
      clock.runtime,
      makeRunner({ a: up }, calls),
    );
    closed.close();
    closed.startScheduled();
    await flush();
    expect(calls).toEqual({ a: 1 });
  });

  it('clears the interval and every deadline timer on close, and discards late settlements', async () => {
    const clock = new MutableRuntime();
    const calls: Record<string, number> = {};
    let settle: (result: HealthCheckResult) => void = () => {};
    const collector = collectorFor(
      options({
        indicators: { a: 'a' },
        scheduled: scheduled(['a'], { timeoutMs: 5000 }),
      }),
      clock.runtime,
      makeRunner({
        a: () =>
          new Promise<HealthCheckResult>((resolve) => {
            settle = resolve;
          }),
      }, calls),
    );
    collector.startScheduled();
    await flush();
    // One interval plus one armed reporting deadline.
    expect(clock.armed).toBe(2);
    collector.close();
    expect(clock.armed).toBe(0);

    settle({ status: 'up', data: {} });
    await flush();
    await advanceBy(clock, 0, 10_000, 1000);
    expect(calls).toEqual({ a: 1 });
    expect(collector.snapshot(INSTANCE).observations[0].state).toBe('never-observed');
  });
});

describe('Collector — snapshot budget', () => {
  it('returns the whole set untruncated when it fits', () => {
    const snapshot = applyHealthSnapshotBudget(
      { instanceId: INSTANCE, state: 'ready', droppedObservations: 0 },
      [
        { indicatorAlias: 'a', state: 'reported', latencyMs: 1, ageMs: 1, origin: 'application' },
        {
          indicatorAlias: 'b',
          state: 'never-observed',
          latencyMs: null,
          ageMs: null,
          origin: 'application',
        },
      ],
    );
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.observations.length).toBe(2);
  });

  it('trims to the largest fitting prefix and sets truncated', () => {
    // ~110 bytes per observation; 3,000 of them exceed the 256 KiB budget.
    const many = Array.from({ length: 3_000 }, (_, i) => ({
      indicatorAlias: `alias-${i.toString().padStart(4, '0')}`,
      state: 'reported' as const,
      status: 'up' as const,
      latencyMs: i,
      ageMs: i,
      origin: 'application' as const,
    }));
    const snapshot = applyHealthSnapshotBudget(
      { instanceId: INSTANCE, state: 'ready', droppedObservations: 0 },
      many,
    );
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.observations.length).toBeLessThan(many.length);
    // The kept observations are a prefix of the input, in order.
    for (let i = 0; i < snapshot.observations.length; i++) {
      expect(snapshot.observations[i].indicatorAlias).toBe(many[i].indicatorAlias);
    }
  });
});
