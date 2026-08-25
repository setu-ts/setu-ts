/**
 * Background job queue contract, implemented by the QueuePlugin's adapters
 * (Redis, RabbitMQ, Memory) under `CAPABILITIES.QUEUE`.
 *
 * @module
 */

/**
 * A queued job delivered to a processor.
 *
 * @typeParam T - The job payload type
 * @since 0.1.0
 */
export interface IJob<T = unknown> {
  /** Queue-assigned job ID. */
  readonly id: string;
  /** The job name it was enqueued under. */
  readonly name: string;
  /** The job payload. */
  readonly data: T;
  /** How many times this job has been attempted (1 on first delivery). */
  readonly attempts: number;
}

/**
 * Processes jobs of one name.
 *
 * @typeParam T - The job payload type
 * @param job - The delivered job
 * @since 0.1.0
 */
export type JobProcessor<T = unknown> = (job: IJob<T>) => void | Promise<void>;

/**
 * Options accepted when enqueueing a job.
 *
 * @since 0.1.0
 */
export interface AddJobOptions {
  /** Delay before the job becomes available, in milliseconds. */
  readonly delayMs?: number;
  /** Maximum attempts before the job is dead-lettered. */
  readonly maxAttempts?: number;
}

/**
 * Options accepted when registering a processor.
 *
 * @since 0.1.0
 */
export interface ProcessOptions {
  /** Jobs processed concurrently by this worker (default 1). */
  readonly concurrency?: number;
  /**
   * Invoked once when a job has exhausted its attempts, immediately before it
   * is dead-lettered — the only programmatic notice that work was permanently
   * abandoned. It does NOT fire on an attempt that will be retried.
   *
   * Without it a dead-lettered job is reachable only by opening a Redis client:
   * {@linkcode IQueue} has no `getJob` and no dead-letter accessor, and the
   * adapters' dead-letter structures are internal.
   *
   * A callback that throws is reported through the application's logger and
   * swallowed; the dead-letter still happens, because losing the job as well as
   * the notification would be strictly worse than losing the notification.
   *
   * @param job - The job as its processor last received it, with the final
   * `attempts` count
   * @param error - The value the processor threw on the final attempt
   * @since 0.3.0
   */
  readonly onFailed?: (job: IJob, error: unknown) => void | Promise<void>;
}

/**
 * Options accepted when scheduling a recurring job.
 *
 * @since 0.1.0
 */
export interface RecurringOptions {
  /** Cron expression controlling the schedule. */
  readonly cron: string;
}

/**
 * Background job queue.
 *
 * @example
 * ```typescript
 * const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);
 * await queue.add('send-email', { to: user.email, template: 'welcome' });
 * queue.process<SendEmailJob>('send-email', async (job) => {
 *   await mailer.send(job.data);
 * }, { concurrency: 3 });
 * ```
 * @since 0.1.0
 */
export interface IQueue {
  /**
   * Enqueues a job.
   *
   * @typeParam T - The payload type
   * @param name - Job name
   * @param data - Job payload
   * @param options - Delay and retry behavior
   * @returns The queue-assigned job ID
   */
  add<T>(name: string, data: T, options?: AddJobOptions): Promise<string>;
  /**
   * Registers a processor for a job name.
   *
   * @typeParam T - The payload type
   * @param name - Job name
   * @param processor - Invoked per job
   * @param options - Concurrency
   */
  process<T>(name: string, processor: JobProcessor<T>, options?: ProcessOptions): void;
  /**
   * Schedules a recurring job.
   *
   * @typeParam T - The payload type
   * @param name - Job name
   * @param data - Payload delivered on each occurrence
   * @param options - Cron schedule
   */
  addRecurring<T>(name: string, data: T, options: RecurringOptions): Promise<void>;
}
