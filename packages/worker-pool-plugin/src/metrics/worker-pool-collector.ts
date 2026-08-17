/**
 * WorkerPoolCollector — owns the worker-pool Prometheus instruments and the
 * push calls that update them.
 *
 * Internal to the plugin (not exported from the barrel): the plugin builds one
 * only when `CAPABILITIES.METRICS` is registered, and threads it through the
 * service into each pool. Absent the metrics capability there is no collector
 * and the pool's behaviour is unchanged.
 *
 * Sampling is a PUSH from the pool's own state transitions, not a timer:
 * `IMetricsService` exposes no scrape-time callback, and an interval that
 * outlives `onClose` leaks a handle per application (the M53
 * `RedisStreamsBroker` defect). This mirrors `HttpCollector`, which creates
 * its instruments once and pushes from the hot path.
 *
 * @module
 */

import type { ICounter, IGauge, IMetricsService, TaskPoolStats } from '@setu-ts/common';
import type { TaskFailureReason, TaskRejectionReason } from './metric-names.ts';
import {
  COUNTER_OPTIONS,
  GAUGE_OPTIONS,
  REASON_LABEL,
  TASK_MODULE_LABEL,
  WORKER_POOL_METRICS,
} from './metric-names.ts';

/**
 * Creates and updates the six worker-pool instruments.
 *
 * @since 0.1.0
 */
export class WorkerPoolCollector {
  readonly #workers: IGauge;
  readonly #busy: IGauge;
  readonly #queued: IGauge;
  readonly #completed: ICounter;
  readonly #failed: ICounter;
  readonly #rejected: ICounter;
  readonly #report: (error: Error) => void;

  /**
   * Creates every instrument eagerly, so all six series exist — with their
   * `# HELP` and `# TYPE` lines — from application startup, before any task
   * has run. An operator scraping a freshly started replica sees the pool
   * declared rather than an empty response.
   *
   * Instrument CREATION is deliberately unguarded: a name colliding with an
   * application-declared metric of another type should fail `register()`
   * loudly at startup rather than degrade silently. Instrument WRITES are the
   * opposite — see the `#guard` note below.
   *
   * @param metrics - The metrics service resolved from `CAPABILITIES.METRICS`
   * @param report - Receives any error thrown by an instrument write
   */
  constructor(metrics: IMetricsService, report: (error: Error) => void) {
    this.#report = report;
    this.#workers = metrics.gauge(
      WORKER_POOL_METRICS.WORKERS,
      GAUGE_OPTIONS[WORKER_POOL_METRICS.WORKERS],
    );
    this.#busy = metrics.gauge(
      WORKER_POOL_METRICS.BUSY,
      GAUGE_OPTIONS[WORKER_POOL_METRICS.BUSY],
    );
    this.#queued = metrics.gauge(
      WORKER_POOL_METRICS.QUEUED,
      GAUGE_OPTIONS[WORKER_POOL_METRICS.QUEUED],
    );
    this.#completed = metrics.counter(
      WORKER_POOL_METRICS.COMPLETED,
      COUNTER_OPTIONS[WORKER_POOL_METRICS.COMPLETED],
    );
    this.#failed = metrics.counter(
      WORKER_POOL_METRICS.FAILED,
      COUNTER_OPTIONS[WORKER_POOL_METRICS.FAILED],
    );
    this.#rejected = metrics.counter(
      WORKER_POOL_METRICS.REJECTED,
      COUNTER_OPTIONS[WORKER_POOL_METRICS.REJECTED],
    );
  }

  /**
   * Writes the three pool-state gauges from one snapshot.
   *
   * Fed from the SAME `TaskPool.stats()` the health indicator reads, so the
   * gauges and `/health` can never disagree. Gauges are absolute (`set`), so a
   * snapshot is the correct input — unlike the counters below.
   *
   * @param stats - A snapshot of one pool's state
   */
  syncGauges(stats: TaskPoolStats): void {
    this.#guard(() => {
      const labels = { [TASK_MODULE_LABEL]: stats.taskModule };
      this.#workers.set(stats.workers, labels);
      this.#busy.set(stats.busy, labels);
      this.#queued.set(stats.queued, labels);
    });
  }

  /**
   * Runs one instrument write, reporting rather than propagating a failure.
   *
   * **Observing the pool must never break it.** An `IMetricsService` is a
   * replaceable capability and its writes genuinely throw — `validateLabels`
   * rejects an undeclared label set, and a substitute implementation may
   * refuse for its own reasons. Unguarded, such a throw reaches the pool from
   * inside a worker `message` callback, where it is an uncaught exception that
   * kills the host process: exactly the X8-2 failure this milestone fixed, by
   * a different door. The task's own settlement is sequenced BEFORE these
   * calls in `TaskPool`, so a metrics outage can neither strand a caller's
   * promise nor lose a completed result.
   */
  #guard(write: () => void): void {
    try {
      write();
    } catch (error) {
      this.#report(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Records one successfully completed task.
   *
   * Increments by one rather than writing `stats().completed`, which is
   * cumulative — feeding a cumulative snapshot into `ICounter.inc` would
   * double-count on every call.
   *
   * @param taskModule - The pool's task-module specifier
   */
  taskCompleted(taskModule: string): void {
    this.#guard(() => {
      this.#completed.inc(1, { [TASK_MODULE_LABEL]: taskModule });
    });
  }

  /**
   * Records one admitted task that failed. Summed over `reason`, this equals
   * `TaskPoolStats.failed` for the same module.
   *
   * @param taskModule - The pool's task-module specifier
   * @param reason - Why the task failed
   */
  taskFailed(taskModule: string, reason: TaskFailureReason): void {
    this.#guard(() => {
      this.#failed.inc(1, { [TASK_MODULE_LABEL]: taskModule, [REASON_LABEL]: reason });
    });
  }

  /**
   * Records one task rejected before admission. Deliberately separate from
   * {@linkcode taskFailed}: these never became tasks, so the pool's own
   * `failed` count cannot see them either.
   *
   * @param taskModule - The task-module specifier the caller asked for
   * @param reason - Why the task was refused
   */
  taskRejected(taskModule: string, reason: TaskRejectionReason): void {
    this.#guard(() => {
      this.#rejected.inc(1, { [TASK_MODULE_LABEL]: taskModule, [REASON_LABEL]: reason });
    });
  }
}
