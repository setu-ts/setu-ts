/**
 * Scheduler service contract.
 *
 * Defines the port that the scheduler plugin implements under
 * `CAPABILITIES.SCHEDULER` (`'scheduler'`). Covers cron, recurring
 * (fixed-interval), and one-shot delayed jobs with retry and
 * distributed locking.
 *
 * @module
 */

/**
 * A scheduled job instance handed to the handler.
 *
 * @typeParam T - The shape of the job payload
 * @since 0.1.0
 */
export interface ScheduledJob<T = unknown> {
  /** Unique job identifier. */
  readonly id: string;
  /** Human-readable job name. */
  readonly name: string;
  /** Payload data supplied by the caller. */
  readonly data: T;
  /** Current attempt number (1-based). */
  readonly attempts: number;
}

/**
 * Handler invoked when a scheduled job fires.
 *
 * @typeParam T - The shape of the job payload
 * @param job - The scheduled job instance
 * @since 0.1.0
 */
export type SchedulerJobHandler<T = unknown> = (
  job: ScheduledJob<T>,
) => void | Promise<void>;

/**
 * Backoff strategy for retry delays.
 *
 * @since 0.1.0
 */
export type SchedulerBackoff = 'fixed' | 'exponential';

/**
 * Retry configuration for a scheduled job.
 *
 * @since 0.1.0
 */
export interface RetryOptions {
  /** Maximum number of attempts before giving up (1-based minimum). */
  readonly limit: number;
  /** Base delay in milliseconds for the first retry. */
  readonly delay: number;
  /** Backoff strategy. Defaults to `'fixed'`. */
  readonly backoff: SchedulerBackoff;
}

/**
 * Options passed when scheduling a job.
 *
 * @typeParam T - The shape of the job payload
 * @since 0.1.0
 */
export interface ScheduleOptions<T = unknown> {
  /** Payload data handed to the handler. */
  readonly data?: T;
  /** Retry configuration. When absent the job runs once. */
  readonly retry?: RetryOptions;
}

/**
 * In-process job scheduler.
 *
 * Supports cron expressions (5-field, UTC), fixed-interval recurring
 * jobs, and one-shot delayed jobs. Execution is process-local and
 * time-driven (no durable persistence).
 *
 * @since 0.1.0
 */
export interface IScheduler {
  /**
   * Schedule a recurring job using a 5-field cron expression (UTC).
   *
   * @param name - Unique job name
   * @param expression - 5-field cron expression
   * @param handler - Callback to invoke on each fire
   * @param options - Optional payload and retry config
   * @throws {Error} If a job with `name` is already scheduled
   */
  cron<T = unknown>(
    name: string,
    expression: string,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void>;

  /**
   * Schedule a recurring job that fires every `intervalMs` milliseconds.
   *
   * @param name - Unique job name
   * @param intervalMs - Interval in milliseconds
   * @param handler - Callback to invoke on each fire
   * @param options - Optional payload and retry config
   * @throws {Error} If a job with `name` is already scheduled
   */
  every<T = unknown>(
    name: string,
    intervalMs: number,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void>;

  /**
   * Schedule a one-shot delayed job.
   *
   * The job fires once after `delayMs` and is then auto-removed.
   *
   * @param name - Unique job name
   * @param delayMs - Delay in milliseconds
   * @param handler - Callback to invoke when the delay expires
   * @param options - Optional payload and retry config
   * @throws {Error} If a job with `name` is already scheduled
   */
  delay<T = unknown>(
    name: string,
    delayMs: number,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void>;

  /**
   * Pause a scheduled job without dropping its configuration.
   *
   * Idempotent — calling pause on an already-paused job is a no-op.
   *
   * @param name - The job name
   * @throws {Error} If no job with `name` exists
   */
  pause(name: string): Promise<void>;

  /**
   * Resume a paused job.
   *
   * For cron jobs the next fire is computed from `now()`. For `every`
   * jobs the interval restarts from `now()`. For `delay` jobs the
   * full original `delayMs` is re-armed from `now()`.
   *
   * Idempotent — calling resume on a running job is a no-op.
   *
   * @param name - The job name
   * @throws {Error} If no job with `name` exists
   */
  resume(name: string): Promise<void>;

  /**
   * Remove a scheduled job entirely.
   *
   * @param name - The job name
   * @throws {Error} If no job with `name` exists
   */
  remove(name: string): Promise<void>;

  /**
   * Return the next scheduled fire time as epoch milliseconds.
   *
   * @param name - The job name
   * @returns Next fire time in epoch ms
   * @throws {Error} If no job with `name` exists or the job is paused
   */
  getNextRun(name: string): Promise<number>;
}
