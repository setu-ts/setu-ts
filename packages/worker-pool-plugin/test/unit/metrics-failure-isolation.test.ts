/**
 * Regression tests: observing the pool must never break the pool.
 *
 * An `IMetricsService` write genuinely throws — `MetricBase.validateLabels`
 * rejects an undeclared or incomplete label set, and the capability is
 * replaceable (AI_GUIDELINES §3.4), so a substitute implementation may refuse
 * for its own reasons. Unguarded, such a throw reached the pool from inside a
 * worker `message` callback, where it is an uncaught exception that kills the
 * host process — the X8-2 failure mode, reintroduced through instrumentation.
 * It also landed BEFORE `task.resolve`, so a task the worker had completed
 * successfully hung its caller forever while the pool counted it as done.
 *
 * Every case here fails without the guard in `WorkerPoolCollector` and the
 * settle-before-observe ordering in `TaskPool`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ICounter, IGauge, IMetric, IMetricsService, MetricOptions } from '@setu-ts/common';

import { TaskPool } from '../../src/pool/task-pool.ts';
import { WorkerPoolCollector } from '../../src/metrics/worker-pool-collector.ts';
import { WORKER_POOL_METRICS } from '../../src/metrics/metric-names.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';
import { RecordingMetrics, recordReports } from '../fixtures/metrics-fakes.ts';

const SPEC = 'file:///tasks/echo.ts';

/**
 * A metrics service whose instruments are created normally but whose WRITES
 * refuse — the shape a real backend takes when a label set is rejected or a
 * replacement implementation declines.
 */
function refusingMetrics(refuse: (name: string) => boolean): IMetricsService {
  const base = new RecordingMetrics();
  const wrap = <T extends IMetric>(instrument: T, name: string): T => {
    if (!refuse(name)) {
      return instrument;
    }
    const boom = (): never => {
      throw new Error(`metrics backend refused a write to "${name}"`);
    };
    return { ...instrument, name, observe: boom, inc: boom, set: boom, dec: boom } as unknown as T;
  };
  return {
    counter: (name: string, options?: MetricOptions): ICounter =>
      wrap(base.counter(name, options), name),
    gauge: (name: string, options?: MetricOptions): IGauge => wrap(base.gauge(name, options), name),
    histogram: (name, options) => base.histogram(name, options),
    summary: (name, options) => base.summary(name, options),
    get: (name: string): IMetric | undefined => base.get(name),
  };
}

function makePool(metrics: IMetricsService, report: (error: Error) => void): {
  pool: TaskPool;
  host: FakeHost;
} {
  const host = new FakeHost(1);
  const pool = new TaskPool(
    { specifier: SPEC, size: 1, maxQueue: 1024, taskTimeoutMs: 0 },
    host,
    createFakeRuntime(new FakeTimers()),
    new WorkerPoolCollector(metrics, report),
  );
  return { pool, host };
}

describe('TaskPool — a failing metrics backend cannot break the pool', () => {
  it('should still deliver a completed task result when the counter refuses', async () => {
    const { report, errors } = recordReports();
    const { pool, host } = makePool(
      refusingMetrics((name) => name === WORKER_POOL_METRICS.COMPLETED),
      report,
    );

    const promise = pool.run('payload');
    host.handles[0].emitReady();
    host.handles[0].replyOk('worker-result');

    // Pre-fix this never settled: the throw landed before `task.resolve`, so
    // the worker's result was lost and the caller waited forever.
    await expect(promise).resolves.toBe('worker-result');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('refused a write');
  });

  it('should still reject a failed task when the counter refuses', async () => {
    const { report, errors } = recordReports();
    const { pool, host } = makePool(
      refusingMetrics((name) => name === WORKER_POOL_METRICS.FAILED),
      report,
    );

    const promise = pool.run('payload');
    host.handles[0].emitReady();
    host.handles[0].replyError({ name: 'Error', message: 'boom' });

    await expect(promise).rejects.toThrow('boom');
    expect(errors).toHaveLength(1);
  });

  it('should not let a gauge write escape into a worker message callback', async () => {
    const { report, errors } = recordReports();
    const { pool, host } = makePool(
      refusingMetrics((name) => name === WORKER_POOL_METRICS.WORKERS),
      report,
    );

    const promise = pool.run('payload');
    // Each of these drives `pump()` + `syncMetrics()` from inside a worker
    // callback. Pre-fix both threw out of the callback — in production, an
    // uncaught exception on the worker's message handler.
    expect(() => host.handles[0].emitReady()).not.toThrow();
    expect(() => host.handles[0].replyOk('worker-result')).not.toThrow();

    await expect(promise).resolves.toBe('worker-result');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should not reject a submitted task because a gauge write failed', async () => {
    const { report } = recordReports();
    const { pool, host } = makePool(
      refusingMetrics((name) => name === WORKER_POOL_METRICS.QUEUED),
      report,
    );

    // `run()` syncs gauges inside its own promise executor. Pre-fix a refusing
    // gauge rejected the caller here while the task stayed queued and still
    // executed on a worker — the caller told it failed, the work done anyway.
    const promise = pool.run('payload');
    host.handles[0].emitReady();
    host.handles[0].replyOk('worker-result');

    await expect(promise).resolves.toBe('worker-result');
    expect(host.handles[0].requests).toHaveLength(1);
  });

  it('should deliver the result even when the failure REPORTER itself throws', async () => {
    // Defence in depth for the settle-before-observe ordering, which the guard
    // alone does not exercise. A reporter can throw for real — `ctx.logger` is
    // an application-supplied `ILogger` and a broken transport throws on
    // `warn`. Only the ordering keeps the caller's promise safe here: with the
    // metric push placed before `task.resolve`, this strands it permanently.
    const { pool, host } = makePool(
      refusingMetrics((name) => name === WORKER_POOL_METRICS.COMPLETED),
      (error: Error): never => {
        throw new Error(`logger transport is down: ${error.message}`);
      },
    );

    const promise = pool.run('payload');
    host.handles[0].emitReady();
    // The reporter's throw still escapes the callback — that is the logger's
    // fault and its own bug — but it must not cost the caller its result.
    try {
      host.handles[0].replyOk('worker-result');
    } catch { /* the reporter's throw, asserted by the settlement below */ }

    await expect(promise).resolves.toBe('worker-result');
  });

  it('should normalise a non-Error thrown by an instrument before reporting it', async () => {
    // A third-party `IMetricsService` is under no obligation to throw an
    // Error; the reporter's contract says it receives one, so the collector
    // must not hand a bare string to a logger that will call `.message`.
    const base = new RecordingMetrics();
    const metrics: IMetricsService = {
      counter: (name: string, options?: MetricOptions): ICounter => {
        const real = base.counter(name, options);
        if (name === WORKER_POOL_METRICS.COMPLETED) {
          return {
            ...real,
            inc: () => {
              throw 'backend refused';
            },
          } as unknown as ICounter;
        }
        return real;
      },
      gauge: (name, options) => base.gauge(name, options),
      histogram: (name, options) => base.histogram(name, options),
      summary: (name, options) => base.summary(name, options),
      get: (name: string): IMetric | undefined => base.get(name),
    };

    const { report, errors } = recordReports();
    const { pool, host } = makePool(metrics, report);

    const promise = pool.run('payload');
    host.handles[0].emitReady();
    host.handles[0].replyOk('worker-result');

    await expect(promise).resolves.toBe('worker-result');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe('backend refused');
  });

  it('should keep the pool serving after a metrics outage', async () => {
    const { report } = recordReports();
    const { pool, host } = makePool(refusingMetrics(() => true), report);

    const first = pool.run('one');
    host.handles[0].emitReady();
    host.handles[0].replyOk('r1');
    await expect(first).resolves.toBe('r1');

    const second = pool.run('two');
    host.handles[0].replyOk('r2');
    await expect(second).resolves.toBe('r2');

    // The pool's own accounting is unaffected by the metrics backend.
    expect(pool.stats()).toMatchObject({ completed: 2, failed: 0, busy: 0, queued: 0 });
  });
});
