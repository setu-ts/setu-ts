/**
 * Queue metric names, label names, and the `MetricOptions` each instrument is
 * created with.
 *
 * Internal to the plugin (not exported from the barrel). One home for all of
 * it so the instruments the collector creates, the series the Prometheus
 * renderer emits, and the names the tests assert cannot drift apart — the M45b
 * `worker-pool` shape.
 *
 * @module
 */

import type { MetricOptions } from '@setu-ts/common';

/**
 * Label carrying the job name.
 *
 * Cardinality is bounded by the job names written in the application's source
 * rather than by traffic, which is what makes it safe to label by.
 */
export const JOB_NAME_LABEL = 'name';

/** Label separating one settlement outcome from another. */
export const OUTCOME_LABEL = 'outcome';

/** The queue instrument names, in Prometheus naming convention. */
export const QUEUE_METRICS = {
  /**
   * Counter: jobs that settled, by outcome.
   *
   * X8-4's operational surface. A job that exhausted its retries was invisible
   * through every surface the framework offered: `IQueue` has no `getJob` and
   * no dead-letter accessor, `/health` reported `{"adapter":"RedisQueue"}`, and
   * `/metrics` carried no queue series at all — so work disappeared and the
   * only way to find out was to open a Redis client.
   */
  JOBS: 'queue_jobs_total',
} as const;

/** Name of one of the queue counters. */
export type QueueCounterName = typeof QUEUE_METRICS.JOBS;

/**
 * Creation options for the queue counters.
 *
 * Keyed on {@linkcode QueueCounterName} rather than `string`, so reading it
 * with a name the union does not carry is a COMPILE error. Under a
 * `Record<string, …>` it would type-check and yield `undefined`, creating an
 * instrument with no declared labels — whose first write then throws from
 * `validateLabels` (the M45b review finding).
 */
export const COUNTER_OPTIONS: Readonly<Record<QueueCounterName, MetricOptions>> = {
  [QUEUE_METRICS.JOBS]: {
    help: 'Total queue jobs settled, by outcome (completed, retried, dead_lettered)',
    labels: [JOB_NAME_LABEL, OUTCOME_LABEL],
  },
};
