/**
 * Unit tests for the health-observation collector (M98d): the latest-only
 * retention seam, the bounded scheduler, the minimized snapshot, and the
 * 256 KiB budget. A mutable clock drives monotonic time and timers so the
 * stale/timeout/scheduling paths are deterministic. No indicator `data`,
 * error text, or absolute time is ever accepted or projected.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HealthCheckResult, IRuntimeServices, TimerHandle } from '@setu-ts/common';
import {
  applyHealthSnapshotBudget,
  COLLECTOR_ERRORS,
  type HealthIndicatorRunner,
  HealthObservationCollector,
} from '../../src/diagnostics/health-observation-collector.ts';
import type { HealthDiagnosticsOptions } from '../../src/interfaces/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const INSTANCE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/**
 * A mutable monotonic clock with controllable timers, built on the shared
 * fake runtime. `advance` moves the clock and fires any due timers, in order.
 *
 * @internal
 */
class MutableRuntime {
  /** The runtime view the collector receives: monotonic clock + timers. */
  readonly runtime: IRuntimeServices;
  #hr = 0;
  #timers = new Map<TimerHandle, { at: number; fn: () => void }>();
  #nextHandle = 1;

  constructor() {
    const base = createFakeRuntime({ hrtime: 0 });
    this.runtime = {
      ...base,
      hrtime: () => this.#hr,
      setTimeout: (fn: () => void, ms: number) => this.addTimer(fn, ms),
      clearTimeout: (handle: TimerHandle) => {
        this.#timers.delete(handle);
      },
      setInterval: (fn: () => void, ms: number) => this.addTimer(fn, ms),
      clearInterval: (handle: TimerHandle) => {
        this.#timers.delete(handle);
      },
    };
  }

  addTimer(fn: () => void, ms: number): TimerHandle {
    const handle = this.#nextHandle++ as TimerHandle;
    this.#timers.set(handle, { at: this.#hr + ms, fn });
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
      this.#timers.delete(due);
      timer.fn();
    }
  }
}

/** A runner that returns a controllable promise per indicator name. */
function makeRunner(
  results: Record<string, () => Promise<HealthCheckResult>>,
): HealthIndicatorRunner {
  return {
    run(name: string): Promise<HealthCheckResult> {
      return results[name]();
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

describe('Collector — construction bounds', () => {
  const clock = new MutableRuntime();
  const runner = makeRunner({});

  it('accepts a valid policy', () => {
    expect(() => new HealthObservationCollector(options(), clock.runtime, runner)).not.toThrow();
  });

  it('refuses more than 64 approved indicators', () => {
    const indicators: Record<string, string> = {};
    for (let i = 0; i < 65; i++) {
      indicators[`name${i}`] = `alias${i}`;
    }
    expect(() => new HealthObservationCollector(options({ indicators }), clock.runtime, runner))
      .toThrow(COLLECTOR_ERRORS.tooManyAliases);
  });

  it('refuses an empty or oversized alias', () => {
    expect(() =>
      new HealthObservationCollector(options({ indicators: { a: '' } }), clock.runtime, runner)
    ).toThrow(COLLECTOR_ERRORS.aliasBytes);
    expect(() =>
      new HealthObservationCollector(
        options({ indicators: { a: 'x'.repeat(65) } }),
        clock.runtime,
        runner,
      )
    ).toThrow(COLLECTOR_ERRORS.aliasBytes);
  });

  it('refuses an alias with a control character', () => {
    expect(() =>
      new HealthObservationCollector(
        options({ indicators: { a: 'bad\x01name' } }),
        clock.runtime,
        runner,
      )
    ).toThrow(COLLECTOR_ERRORS.aliasControl);
  });

  it('refuses a duplicate alias', () => {
    expect(() =>
      new HealthObservationCollector(
        options({ indicators: { a: 'same', b: 'same' } }),
        clock.runtime,
        runner,
      )
    ).toThrow(COLLECTOR_ERRORS.duplicateAlias);
  });

  it('refuses a non-positive or non-integer staleAfterMs', () => {
    expect(() =>
      new HealthObservationCollector(options({ staleAfterMs: 0 }), clock.runtime, runner)
    ).toThrow(COLLECTOR_ERRORS.badStaleAfter);
    expect(() =>
      new HealthObservationCollector(options({ staleAfterMs: 1.5 }), clock.runtime, runner)
    ).toThrow(COLLECTOR_ERRORS.badStaleAfter);
  });

  it('refuses a scheduled indicator that is not approved', () => {
    expect(() =>
      new HealthObservationCollector(
        options({
          scheduled: {
            indicators: ['not-approved'],
            intervalMs: 1000,
            timeoutMs: 1,
            concurrency: 1,
          },
        }),
        clock.runtime,
        runner,
      )
    ).toThrow(COLLECTOR_ERRORS.scheduledNotApproved);
  });

  it('refuses out-of-range interval, timeout, and concurrency', () => {
    const base = { indicators: ['db.check'] as const, timeoutMs: 1, concurrency: 1 };
    expect(() =>
      new HealthObservationCollector(
        options({ scheduled: { ...base, intervalMs: 999 } }),
        clock.runtime,
        runner,
      )
    ).toThrow(COLLECTOR_ERRORS.badInterval);
    expect(() =>
      new HealthObservationCollector(
        options({ scheduled: { ...base, intervalMs: 300_001 } }),
        clock.runtime,
        runner,
      )
    ).toThrow(COLLECTOR_ERRORS.badInterval);
    expect(() =>
      new HealthObservationCollector(
        options({
          scheduled: { indicators: ['db.check'], intervalMs: 1000, timeoutMs: 0, concurrency: 1 },
        }),
        clock.runtime,
        runner,
      )
    ).toThrow(COLLECTOR_ERRORS.badTimeout);
    expect(() =>
      new HealthObservationCollector(
        options({
          scheduled: {
            indicators: ['db.check'],
            intervalMs: 1000,
            timeoutMs: 30_001,
            concurrency: 1,
          },
        }),
        clock.runtime,
        runner,
      )
    ).toThrow(COLLECTOR_ERRORS.badTimeout);
    expect(() =>
      new HealthObservationCollector(
        options({
          scheduled: { indicators: ['db.check'], intervalMs: 1000, timeoutMs: 1, concurrency: 5 },
        }),
        clock.runtime,
        runner,
      )
    ).toThrow(COLLECTOR_ERRORS.badConcurrency);
  });
});

describe('Collector — retention seam', () => {
  it('retains the latest outcome per approved alias and counts unapproved as dropped', () => {
    const clock = new MutableRuntime();
    const collector = new HealthObservationCollector(options(), clock.runtime, makeRunner({}));
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
    const collector = new HealthObservationCollector(options(), clock.runtime, makeRunner({}));
    const snapshot = collector.snapshot(INSTANCE);
    const cache = snapshot.observations.find((o) => o.indicatorAlias === 'cache')!;
    expect(cache.state).toBe('never-observed');
    expect(cache.latencyMs).toBeNull();
    expect(cache.ageMs).toBeNull();
    expect('status' in cache).toBe(false);
  });

  it('reports the inspector state from data freshness: no-data, ready, stale', () => {
    const clock = new MutableRuntime();
    const collector = new HealthObservationCollector(
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
    const collector = new HealthObservationCollector(options(), clock.runtime, makeRunner({}));
    collector.close();
    collector.report('db.check', { state: 'reported', status: 'up', latencyMs: 3 }, 'application');
    const snapshot = collector.snapshot(INSTANCE);
    expect(snapshot.observations.every((o) => o.state === 'never-observed')).toBe(true);
  });

  it('refuses an empty instance identifier', () => {
    const clock = new MutableRuntime();
    const collector = new HealthObservationCollector(options(), clock.runtime, makeRunner({}));
    expect(() => collector.snapshot('')).toThrow(COLLECTOR_ERRORS.badInstanceId);
  });

  it('returns a frozen snapshot', () => {
    const clock = new MutableRuntime();
    const collector = new HealthObservationCollector(options(), clock.runtime, makeRunner({}));
    collector.report('db.check', { state: 'reported', status: 'up', latencyMs: 3 }, 'application');
    const snapshot = collector.snapshot(INSTANCE);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.observations)).toBe(true);
  });
});

describe('Collector — bounded scheduler', () => {
  it('reports a scheduled check as reported with the framework status', async () => {
    const clock = new MutableRuntime();
    const collector = new HealthObservationCollector(
      options({
        indicators: { 'db.check': 'database' },
        scheduled: { indicators: ['db.check'], intervalMs: 1000, timeoutMs: 50, concurrency: 1 },
      }),
      clock.runtime,
      makeRunner({ 'db.check': up }),
    );
    collector.startScheduled();
    // The first cycle runs immediately (non-awaited); let it settle.
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = collector.snapshot(INSTANCE);
    const database = snapshot.observations[0];
    expect(database.state).toBe('reported');
    expect(database.status).toBe('up');
    expect(database.origin).toBe('scheduled');
    collector.close();
  });

  it('reports a rejecting check as failed without leaking error text', async () => {
    const clock = new MutableRuntime();
    const collector = new HealthObservationCollector(
      options({
        indicators: { 'db.check': 'database' },
        scheduled: { indicators: ['db.check'], intervalMs: 1000, timeoutMs: 50, concurrency: 1 },
      }),
      clock.runtime,
      makeRunner({ 'db.check': fail }),
    );
    collector.startScheduled();
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = collector.snapshot(INSTANCE);
    expect(snapshot.observations[0].state).toBe('failed');
    expect(JSON.stringify(snapshot)).not.toContain('canary-error-text');
    collector.close();
  });

  it('reports a hung check as timed-out but holds the in-flight gate until it settles', async () => {
    const clock = new MutableRuntime();
    let resolveRaw: (value: HealthCheckResult) => void = () => {};
    const collector = new HealthObservationCollector(
      options({
        indicators: { 'db.check': 'database' },
        scheduled: { indicators: ['db.check'], intervalMs: 1000, timeoutMs: 10, concurrency: 1 },
      }),
      clock.runtime,
      makeRunner({
        'db.check': () =>
          new Promise<HealthCheckResult>((resolve) => {
            resolveRaw = resolve;
          }),
      }),
    );
    collector.startScheduled();
    // Advance past the reporting deadline; the raw check is still in flight.
    clock.advance(10);
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = collector.snapshot(INSTANCE);
    expect(snapshot.observations[0].state).toBe('timed-out');
    // The in-flight gate is held: a second cycle for the same indicator does
    // not start a replacement while the raw callback is unsettled.
    collector.close();
    resolveRaw({ status: 'up', data: {} });
  });

  it('runs scheduled checks up to the concurrency cap per cycle', async () => {
    const clock = new MutableRuntime();
    let running = 0;
    let maxRunning = 0;
    const track = (): Promise<HealthCheckResult> =>
      new Promise<HealthCheckResult>((resolve) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        setTimeout(() => {
          running -= 1;
          resolve({ status: 'up', data: {} });
        }, 5);
      });
    const collector = new HealthObservationCollector(
      options({
        indicators: { 'a': 'alpha', 'b': 'beta', 'c': 'gamma' },
        scheduled: {
          indicators: ['a', 'b', 'c'],
          intervalMs: 1000,
          timeoutMs: 100,
          concurrency: 2,
        },
      }),
      clock.runtime,
      makeRunner({ a: track, b: track, c: track }),
    );
    collector.startScheduled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxRunning).toBeLessThanOrEqual(2);
    collector.close();
  });

  it('clears the interval and discards in-flight work on close', async () => {
    const clock = new MutableRuntime();
    const collector = new HealthObservationCollector(
      options({
        indicators: { 'db.check': 'database' },
        scheduled: { indicators: ['db.check'], intervalMs: 1000, timeoutMs: 50, concurrency: 1 },
      }),
      clock.runtime,
      makeRunner({ 'db.check': hang }),
    );
    collector.startScheduled();
    await Promise.resolve();
    collector.close();
    // After close, advancing the clock fires no further cycles and the
    // retained observation is cleared.
    clock.advance(10_000);
    const snapshot = collector.snapshot(INSTANCE);
    expect(snapshot.observations.every((o) => o.state === 'never-observed')).toBe(true);
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
