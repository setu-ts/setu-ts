/**
 * QueueCollector — owns the queue's Prometheus instruments and the push calls
 * that update them.
 *
 * Internal to the plugin (not exported from the barrel): the plugin builds one
 * only when `CAPABILITIES.METRICS` is registered and threads it into the
 * service. Absent the metrics capability there is no collector and behaviour is
 * unchanged.
 *
 * Sampling is a PUSH from each job's settlement, not a timer: `IMetricsService`
 * exposes no scrape-time callback, and an interval outliving `disconnect()`
 * leaks a handle per application (the M53 `RedisStreamsBroker` defect). The
 * counter is incremented at the ONE site that settles a job, so summing it over
 * `outcome` always equals the number of jobs that settled.
 *
 * @module
 */

import type { ICounter, IMetricsService } from '@setu-ts/common';
import type { JobOutcome } from '../processors/job-processor.ts';
import { COUNTER_OPTIONS, JOB_NAME_LABEL, OUTCOME_LABEL, QUEUE_METRICS } from './metric-names.ts';

/**
 * Creates and updates the queue instruments.
 *
 * @since 0.3.0
 */
export class QueueCollector {
  readonly #jobs: ICounter;
  readonly #report: (error: Error) => void;

  /**
   * Creates the instrument eagerly, so the series exists — with its `# HELP`
   * and `# TYPE` lines — from application startup, before any job has run. An
   * operator scraping a freshly started replica sees the queue declared rather
   * than an empty response.
   *
   * Instrument CREATION is deliberately unguarded: a name colliding with an
   * application-declared metric of another type should fail `register()` loudly
   * at startup rather than degrade silently. Instrument WRITES are the opposite
   * — see {@linkcode jobSettled}.
   *
   * @param metrics - The metrics service resolved from `CAPABILITIES.METRICS`
   * @param report - Receives any error thrown by an instrument write
   */
  constructor(metrics: IMetricsService, report: (error: Error) => void) {
    this.#report = report;
    this.#jobs = metrics.counter(QUEUE_METRICS.JOBS, COUNTER_OPTIONS[QUEUE_METRICS.JOBS]);
  }

  /**
   * Records one settled job.
   *
   * Guarded, because an instrument write is a throwing call: `MetricBase`
   * validates its labels and `IMetricsService` is a replaceable capability, so
   * a refusing backend must not be able to take down the worker loop or leave
   * a job unsettled (the M45b review finding).
   *
   * @param name - The job name
   * @param outcome - How the job settled
   */
  jobSettled(name: string, outcome: JobOutcome): void {
    try {
      this.#jobs.inc(1, { [JOB_NAME_LABEL]: name, [OUTCOME_LABEL]: outcome });
    } catch (error) {
      this.#report(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
