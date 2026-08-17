/**
 * Worker-pool metric names, label names, reason vocabularies, and the
 * `MetricOptions` each instrument is created with.
 *
 * Internal to the plugin (not exported from the barrel). One home for all of
 * it so the instruments the collector creates, the series the Prometheus
 * renderer emits, and the names the tests assert cannot drift apart.
 *
 * @module
 */

import type { MetricOptions } from '@setu-ts/common';

/**
 * Label carrying the pool's task-module specifier — the same string
 * `TaskPoolStats.taskModule` reports.
 *
 * Cardinality is bounded by the number of task modules written in the
 * application's source, not by traffic, which is why it is safe to label by
 * (unlike an HTTP path — see `HttpCollector`, which refuses one for that
 * reason).
 */
export const TASK_MODULE_LABEL = 'task_module';

/** Label separating one failure or rejection cause from another. */
export const REASON_LABEL = 'reason';

/** The six instrument names, in Prometheus naming convention. */
export const WORKER_POOL_METRICS = {
  /** Gauge: workers alive in the pool. */
  WORKERS: 'worker_pool_workers',
  /** Gauge: workers currently executing a task. */
  BUSY: 'worker_pool_busy_workers',
  /** Gauge: tasks waiting in the pool's queue. */
  QUEUED: 'worker_pool_queued_tasks',
  /** Counter: tasks that settled successfully. */
  COMPLETED: 'worker_pool_tasks_completed_total',
  /** Counter: admitted tasks that then failed. */
  FAILED: 'worker_pool_tasks_failed_total',
  /** Counter: tasks never admitted to a pool. */
  REJECTED: 'worker_pool_tasks_rejected_total',
} as const;

/**
 * Why an ADMITTED task failed. The sum over this label equals
 * `TaskPoolStats.failed` for the same module, because every value here is
 * pushed from a site that also increments the pool's own `failedCount`.
 *
 * - `handler` — the task handler threw inside the worker.
 * - `timeout` — the task exceeded its timeout.
 * - `crash` — the worker died (module evaluation failure or uncaught error).
 * - `clone` — the input could not be structured-cloned onto the worker.
 * - `shutdown` — the pool was shut down while the task was in flight or queued.
 */
export type TaskFailureReason = 'handler' | 'timeout' | 'crash' | 'clone' | 'shutdown';

/**
 * Why a task was never admitted. These are deliberately NOT counted as
 * failures: they never became a task, so `TaskPoolStats.failed` cannot see
 * them either (`TaskPool.run` rejects before constructing one).
 *
 * - `queue_full` — the pending queue was at its bound. The saturation signal.
 * - `pool_closed` — `run()` was called after the pool was shut down.
 * - `unavailable` — the runtime provides no worker host (e.g. Cloudflare
 *   Workers), so no pool exists at all.
 */
export type TaskRejectionReason = 'queue_full' | 'pool_closed' | 'unavailable';

/** Creation options for the three pool-state gauges. */
export const GAUGE_OPTIONS: Readonly<Record<string, MetricOptions>> = {
  [WORKER_POOL_METRICS.WORKERS]: {
    help: 'Worker threads alive in the pool',
    labels: [TASK_MODULE_LABEL],
  },
  [WORKER_POOL_METRICS.BUSY]: {
    help: 'Worker threads currently executing a task',
    labels: [TASK_MODULE_LABEL],
  },
  [WORKER_POOL_METRICS.QUEUED]: {
    help: 'Tasks waiting in the pool queue',
    labels: [TASK_MODULE_LABEL],
  },
};

/** Creation options for the three task counters. */
export const COUNTER_OPTIONS: Readonly<Record<string, MetricOptions>> = {
  [WORKER_POOL_METRICS.COMPLETED]: {
    help: 'Total worker tasks completed successfully',
    labels: [TASK_MODULE_LABEL],
  },
  [WORKER_POOL_METRICS.FAILED]: {
    help: 'Total worker tasks that failed after being admitted',
    labels: [TASK_MODULE_LABEL, REASON_LABEL],
  },
  [WORKER_POOL_METRICS.REJECTED]: {
    help: 'Total worker tasks rejected before admission',
    labels: [TASK_MODULE_LABEL, REASON_LABEL],
  },
};
