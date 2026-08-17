/**
 * Unit tests for the worker-pool metrics: instrument creation, the gauge
 * sync contract (gauges always equal `stats()`), the counter push sites, and
 * the deliberate split between admitted-then-failed and never-admitted.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { TaskPool } from '../../src/pool/task-pool.ts';
import { WorkerPoolCollector } from '../../src/metrics/worker-pool-collector.ts';
import {
  REASON_LABEL,
  TASK_MODULE_LABEL,
  WORKER_POOL_METRICS,
} from '../../src/metrics/metric-names.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';
import { RecordingMetrics } from '../fixtures/metrics-fakes.ts';

const SPEC = 'file:///tasks/echo.ts';
const MODULE_LABELS = { [TASK_MODULE_LABEL]: SPEC };

function makeInstrumentedPool(
  overrides?: { size?: number; maxQueue?: number; taskTimeoutMs?: number },
): {
  pool: TaskPool;
  host: FakeHost;
  timers: FakeTimers;
  metrics: RecordingMetrics;
} {
  const host = new FakeHost(2);
  const timers = new FakeTimers();
  const runtime = createFakeRuntime(timers);
  const metrics = new RecordingMetrics();
  const pool = new TaskPool(
    {
      specifier: SPEC,
      size: overrides?.size ?? 2,
      maxQueue: overrides?.maxQueue ?? 1024,
      taskTimeoutMs: overrides?.taskTimeoutMs ?? 0,
    },
    host,
    runtime,
    new WorkerPoolCollector(metrics),
  );
  return { pool, host, timers, metrics };
}

/** Asserts the three gauges agree with the pool's own snapshot. */
function expectGaugesMatchStats(pool: TaskPool, metrics: RecordingMetrics): void {
  const stats = pool.stats();
  expect(metrics.require(WORKER_POOL_METRICS.WORKERS).valueFor(MODULE_LABELS)).toBe(stats.workers);
  expect(metrics.require(WORKER_POOL_METRICS.BUSY).valueFor(MODULE_LABELS)).toBe(stats.busy);
  expect(metrics.require(WORKER_POOL_METRICS.QUEUED).valueFor(MODULE_LABELS)).toBe(stats.queued);
}

describe('WorkerPoolCollector — instrument creation', () => {
  it('should create all six instruments eagerly, before any task runs', () => {
    const metrics = new RecordingMetrics();
    new WorkerPoolCollector(metrics);

    expect([...metrics.metrics.keys()].sort()).toEqual([
      WORKER_POOL_METRICS.BUSY,
      WORKER_POOL_METRICS.QUEUED,
      WORKER_POOL_METRICS.COMPLETED,
      WORKER_POOL_METRICS.FAILED,
      WORKER_POOL_METRICS.REJECTED,
      WORKER_POOL_METRICS.WORKERS,
    ].sort());
  });

  it('should declare the documented type and labels for each instrument', () => {
    const metrics = new RecordingMetrics();
    new WorkerPoolCollector(metrics);

    expect(metrics.require(WORKER_POOL_METRICS.WORKERS).type).toBe('gauge');
    expect(metrics.require(WORKER_POOL_METRICS.BUSY).type).toBe('gauge');
    expect(metrics.require(WORKER_POOL_METRICS.QUEUED).type).toBe('gauge');
    expect(metrics.require(WORKER_POOL_METRICS.COMPLETED).type).toBe('counter');
    expect(metrics.require(WORKER_POOL_METRICS.FAILED).type).toBe('counter');
    expect(metrics.require(WORKER_POOL_METRICS.REJECTED).type).toBe('counter');

    expect(metrics.require(WORKER_POOL_METRICS.WORKERS).labels).toEqual([TASK_MODULE_LABEL]);
    expect(metrics.require(WORKER_POOL_METRICS.COMPLETED).labels).toEqual([TASK_MODULE_LABEL]);
    expect(metrics.require(WORKER_POOL_METRICS.FAILED).labels).toEqual([
      TASK_MODULE_LABEL,
      REASON_LABEL,
    ]);
    expect(metrics.require(WORKER_POOL_METRICS.REJECTED).labels).toEqual([
      TASK_MODULE_LABEL,
      REASON_LABEL,
    ]);
  });

  it('should give every instrument non-empty help text', () => {
    const metrics = new RecordingMetrics();
    new WorkerPoolCollector(metrics);

    for (const metric of metrics.metrics.values()) {
      expect(metric.help.length).toBeGreaterThan(0);
      expect(metric.help).not.toBe(metric.name);
    }
  });
});

describe('WorkerPoolCollector — gauges track stats() through every transition', () => {
  it('should match stats() after enqueue, spawn, ready-dispatch and success', async () => {
    const { pool, host, metrics } = makeInstrumentedPool();

    const promise = pool.run({ n: 1 });
    expectGaugesMatchStats(pool, metrics);
    expect(metrics.require(WORKER_POOL_METRICS.QUEUED).valueFor(MODULE_LABELS)).toBe(1);

    host.handles[0].emitReady();
    expectGaugesMatchStats(pool, metrics);
    expect(metrics.require(WORKER_POOL_METRICS.BUSY).valueFor(MODULE_LABELS)).toBe(1);
    expect(metrics.require(WORKER_POOL_METRICS.QUEUED).valueFor(MODULE_LABELS)).toBe(0);

    host.handles[0].replyOk('done');
    await expect(promise).resolves.toBe('done');
    expectGaugesMatchStats(pool, metrics);
    expect(metrics.require(WORKER_POOL_METRICS.BUSY).valueFor(MODULE_LABELS)).toBe(0);
  });

  it('should match stats() after a handler error', async () => {
    const { pool, host, metrics } = makeInstrumentedPool();

    const promise = pool.run(1);
    host.handles[0].emitReady();
    host.handles[0].replyError({ name: 'Error', message: 'boom' });

    await expect(promise).rejects.toThrow();
    expectGaugesMatchStats(pool, metrics);
  });

  it('should match stats() after a worker crash drops the slot', async () => {
    const { pool, host, metrics } = makeInstrumentedPool();

    const promise = pool.run(1);
    host.handles[0].emitReady();
    host.handles[0].emitWorkerError(new Error('crashed'));

    await expect(promise).rejects.toThrow();
    expectGaugesMatchStats(pool, metrics);
    expect(metrics.require(WORKER_POOL_METRICS.WORKERS).valueFor(MODULE_LABELS)).toBe(0);
  });

  it('should match stats() after a timeout terminates the worker', async () => {
    const { pool, host, timers, metrics } = makeInstrumentedPool({ taskTimeoutMs: 50 });

    const promise = pool.run(1);
    host.handles[0].emitReady();
    timers.fire();

    await expect(promise).rejects.toThrow();
    expectGaugesMatchStats(pool, metrics);
  });

  it('should match stats() after shutdown drains the pool', async () => {
    const { pool, host, metrics } = makeInstrumentedPool();

    const promise = pool.run(1);
    host.handles[0].emitReady();
    await pool.shutdown();

    await expect(promise).rejects.toThrow();
    expectGaugesMatchStats(pool, metrics);
    expect(metrics.require(WORKER_POOL_METRICS.WORKERS).valueFor(MODULE_LABELS)).toBe(0);
    expect(metrics.require(WORKER_POOL_METRICS.BUSY).valueFor(MODULE_LABELS)).toBe(0);
    expect(metrics.require(WORKER_POOL_METRICS.QUEUED).valueFor(MODULE_LABELS)).toBe(0);
  });
});

describe('WorkerPoolCollector — counters', () => {
  it('should increment completed by one per task, never by the cumulative snapshot', async () => {
    const { pool, host, metrics } = makeInstrumentedPool({ size: 1 });

    for (let n = 0; n < 3; n++) {
      const promise = pool.run(n);
      if (n === 0) {
        host.handles[0].emitReady();
      }
      host.handles[0].replyOk(n);
      await expect(promise).resolves.toBe(n);
    }

    // Feeding stats().completed (1, then 2, then 3) into inc() would total 6.
    expect(metrics.require(WORKER_POOL_METRICS.COMPLETED).valueFor(MODULE_LABELS)).toBe(3);
    expect(pool.stats().completed).toBe(3);
  });

  it('should label each failure with its reason and sum to stats().failed', async () => {
    const { pool, host, timers, metrics } = makeInstrumentedPool({ size: 1, taskTimeoutMs: 50 });

    // handler error
    const handlerFailure = pool.run('a');
    host.handles[0].emitReady();
    host.handles[0].replyError({ name: 'Error', message: 'boom' });
    await expect(handlerFailure).rejects.toThrow();

    // timeout — a handler error RETAINS the worker, so this dispatches to the
    // same still-ready handle rather than spawning a second one.
    const timedOut = pool.run('b');
    expect(host.handles).toHaveLength(1);
    timers.fire();
    await expect(timedOut).rejects.toThrow();

    const failed = metrics.require(WORKER_POOL_METRICS.FAILED);
    expect(failed.valueFor({ ...MODULE_LABELS, [REASON_LABEL]: 'handler' })).toBe(1);
    expect(failed.valueFor({ ...MODULE_LABELS, [REASON_LABEL]: 'timeout' })).toBe(1);
    expect(failed.total()).toBe(pool.stats().failed);
  });

  it('should count a shutdown-cancelled task as a failure with reason shutdown', async () => {
    const { pool, host, metrics } = makeInstrumentedPool();

    const promise = pool.run(1);
    host.handles[0].emitReady();
    await pool.shutdown();
    await expect(promise).rejects.toThrow();

    const failed = metrics.require(WORKER_POOL_METRICS.FAILED);
    expect(failed.valueFor({ ...MODULE_LABELS, [REASON_LABEL]: 'shutdown' })).toBe(1);
    expect(failed.total()).toBe(pool.stats().failed);
  });

  it('should record a queue-full refusal as a rejection, NOT a failure', async () => {
    const { pool, host, metrics } = makeInstrumentedPool({ size: 1, maxQueue: 1 });

    const accepted = pool.run('first');
    const refused = pool.run('second');
    await expect(refused).rejects.toThrow('queue');

    const rejected = metrics.require(WORKER_POOL_METRICS.REJECTED);
    expect(rejected.valueFor({ ...MODULE_LABELS, [REASON_LABEL]: 'queue_full' })).toBe(1);
    // The pool's own `failed` count cannot see a pre-admission refusal, and
    // the failure counter deliberately mirrors it exactly.
    expect(metrics.require(WORKER_POOL_METRICS.FAILED).total()).toBe(0);
    expect(pool.stats().failed).toBe(0);

    host.handles[0].emitReady();
    host.handles[0].replyOk('ok');
    await expect(accepted).resolves.toBe('ok');
  });

  it('should record a run after shutdown as a pool_closed rejection', async () => {
    const { pool, metrics } = makeInstrumentedPool();

    await pool.shutdown();
    await expect(pool.run('late')).rejects.toThrow('shut down');

    expect(
      metrics.require(WORKER_POOL_METRICS.REJECTED)
        .valueFor({ ...MODULE_LABELS, [REASON_LABEL]: 'pool_closed' }),
    ).toBe(1);
    expect(metrics.require(WORKER_POOL_METRICS.FAILED).total()).toBe(0);
  });
});

describe('WorkerPoolCollector — sampling model', () => {
  it('should arm no interval timer for metrics across a full task lifecycle', async () => {
    const { pool, host, timers, metrics } = makeInstrumentedPool();

    const promise = pool.run(1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('done');
    await expect(promise).resolves.toBe('done');
    await pool.shutdown();

    // The design is a push from state transitions: an interval that outlives
    // onClose leaks a handle per application (M53 RedisStreamsBroker).
    expect(timers.intervals).toEqual([]);
    expect(metrics.require(WORKER_POOL_METRICS.COMPLETED).valueFor(MODULE_LABELS)).toBe(1);
  });
});
