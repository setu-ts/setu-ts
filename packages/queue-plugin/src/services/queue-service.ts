/**
 * Queue service implementation.
 *
 * Implements IQueue with worker poll loop, retry with backoff,
 * per-name concurrency, and cron-driven recurring scheduling.
 *
 * @module
 */

import type {
  AddJobOptions,
  HealthCheckResult,
  IJob,
  IQueue,
  JobProcessor,
  ProcessOptions,
  RecurringOptions,
} from '@setu-ts/common';
import type { HealthIndicatorFn, IRuntimeServices, TimerHandle } from '@setu-ts/common';
import type { QueueAdapter, QueueDepths } from '../adapters/queue-adapter.ts';
import type { StoredJob, StoredRecurring } from '../interfaces/index.ts';
import { runJob } from '../processors/job-processor.ts';
import type { JobOutcome } from '../processors/job-processor.ts';
import type { QueueCollector } from '../metrics/queue-collector.ts';
import { cronNextMs } from '../scheduler/cron-calculator.ts';

/**
 * Minimal logger surface the service reports through — structurally compatible
 * with `ILogger` so the plugin can pass the resolved logger capability without
 * this package depending on the logger plugin.
 *
 * @since 0.1.0
 */
export interface QueueLogger {
  /** Logs at `error` severity. */
  error(message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Internal processor registration.
 */
interface ProcessorRegistration<T> {
  processor: JobProcessor<T>;
  concurrency: number;
  inFlight: number;
  reserveInProgress: boolean;
  /**
   * The application's `ProcessOptions.onFailed`, kept per name because it is
   * registered per processor.
   */
  onFailed?: (job: IJob<T>, error: unknown) => void | Promise<void>;
}

/**
 * Queue service implementing IQueue.
 *
 * Owns the backend-agnostic machinery:
 * - Worker poll loop for processing jobs
 * - Retry with exponential backoff
 * - Per-name concurrency control
 * - Cron-driven recurring scheduling
 *
 * Delegates storage to a QueueAdapter.
 *
 * @since 0.1.0
 */
export class QueueService implements IQueue {
  #adapter: QueueAdapter;
  #runtime: IRuntimeServices;
  #defaultMaxAttempts: number;
  #pollIntervalMs: number;
  #processors: Map<string, ProcessorRegistration<unknown>>;
  // Opaque per the IRuntimeServices contract: store exactly what setInterval
  // returned and hand that same value back to clearInterval.
  #workerHandle: TimerHandle | null = null;
  #recurringHandle: TimerHandle | null = null;
  #connected = false;
  #logger: QueueLogger | undefined;
  /**
   * Present only when the application registered `CAPABILITIES.METRICS`. Every
   * call site is optional-chained, so an application without the metrics plugin
   * runs exactly the code that shipped before X8-4.
   */
  #collector: QueueCollector | undefined;

  constructor(
    adapter: QueueAdapter,
    runtime: IRuntimeServices,
    options?: {
      defaultMaxAttempts?: number;
      pollIntervalMs?: number;
      /** Optional logger; when absent, failures are reported nowhere (see #report). */
      logger?: QueueLogger | undefined;
      /** Optional metrics collector; absent when the metrics capability is not registered. */
      collector?: QueueCollector | undefined;
    },
  ) {
    this.#adapter = adapter;
    this.#runtime = runtime;
    this.#defaultMaxAttempts = options?.defaultMaxAttempts ?? 3;
    this.#pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.#processors = new Map();
    this.#logger = options?.logger;
    this.#collector = options?.collector;
  }

  /**
   * Reports a background failure through the logger when one is available.
   *
   * The poll loop, the recurring loop, and the job runner all used to discard
   * their errors into an empty `catch` — an adapter outage or a failing job
   * produced NO signal anywhere, and the code comments said "in production,
   * consider injecting a logger". This is that logger. Reporting itself is
   * guarded so a broken logger cannot take the loop down.
   *
   * @param message - What failed
   * @param error - The thrown value
   * @param meta - Extra context (job id, name, attempt)
   */
  #report(message: string, error: unknown, meta?: Record<string, unknown>): void {
    if (this.#logger === undefined) {
      return;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      this.#logger.error(message, {
        error: err.message,
        ...(err.stack !== undefined && { stack: err.stack }),
        ...meta,
      });
    } catch {
      // A broken logger must not escalate into a dead worker loop.
    }
  }

  async connect(): Promise<void> {
    if (this.#connected) {
      return;
    }
    await this.#adapter.connect();
    this.#connected = true;
    this.#startWorkerLoop();
    this.#startRecurringLoop();
  }

  async disconnect(): Promise<void> {
    // Stop worker loop
    if (this.#workerHandle !== null) {
      this.#runtime.clearInterval(this.#workerHandle);
      this.#workerHandle = null;
    }

    // Stop recurring loop
    if (this.#recurringHandle !== null) {
      this.#runtime.clearInterval(this.#recurringHandle);
      this.#recurringHandle = null;
    }

    await this.#adapter.disconnect();
    this.#connected = false;
  }

  isReady(): boolean {
    return this.#connected && this.#adapter.isReady();
  }

  async add<T>(name: string, data: T, options?: AddJobOptions): Promise<string> {
    const id = this.#runtime.uuid();
    const maxAttempts = options?.maxAttempts ?? this.#defaultMaxAttempts;
    const now = this.#runtime.now();
    const availableAtMs = options?.delayMs !== undefined ? now + options.delayMs : now;

    const job: StoredJob<T> = {
      id,
      name,
      data,
      attempts: 0, // Will be 1 on first delivery (set in reserve)
      maxAttempts,
      availableAtMs,
    };

    await this.#adapter.enqueue(job);
    return id;
  }

  process<T>(name: string, processor: JobProcessor<T>, options?: ProcessOptions): void {
    const concurrency = options?.concurrency ?? 1;

    this.#processors.set(name, {
      processor: processor as JobProcessor<unknown>,
      concurrency,
      inFlight: 0,
      reserveInProgress: false,
      // Omitted rather than assigned `undefined` (`exactOptionalPropertyTypes`).
      ...(options?.onFailed === undefined ? {} : { onFailed: options.onFailed }),
    } as ProcessorRegistration<unknown>);
  }

  async addRecurring<T>(name: string, data: T, options: RecurringOptions): Promise<void> {
    const id = this.#runtime.uuid();
    const now = this.#runtime.now();

    // Validate cron by computing next fire time
    const nextRunAtMs = cronNextMs(options.cron, now);

    const rec: StoredRecurring = {
      id,
      name,
      data,
      cron: options.cron,
      nextRunAtMs,
    };

    await this.#adapter.storeRecurring(rec);
  }

  /**
   * Creates a health indicator for this service.
   *
   * M70c: reports BOTH signals. `isReady()` is lifecycle (never started /
   * shut down → `down`); `isHealthy()` is reachability (the backend answers
   * right now). A ready-but-unreachable adapter is `down` with
   * `data.reachable: false`; an adapter that cannot probe is `up` with
   * `data.reachable: 'unknown'`. `data.adapter` is preserved.
   */
  createHealthIndicator(): HealthIndicatorFn {
    return async (): Promise<HealthCheckResult> => {
      const adapterName = this.#adapter.constructor.name;
      if (!this.isReady()) {
        return { status: 'down', data: { adapter: adapterName, reachable: false } };
      }
      const depths = await this.#collectDepths();
      if (typeof this.#adapter.isHealthy !== 'function') {
        return {
          status: 'up',
          data: { adapter: adapterName, reachable: 'unknown', ...depths },
        };
      }
      const reachable = await this.#adapter.isHealthy();
      if (reachable === false) {
        return { status: 'down', data: { adapter: adapterName, reachable: false, ...depths } };
      }
      return { status: 'up', data: { adapter: adapterName, reachable: true, ...depths } };
    };
  }

  /**
   * Reads the ready/processing/dead depth of every name this instance
   * processes, when the adapter can report one.
   *
   * X8-4: a dead-lettered job was invisible through every surface — the
   * indicator's entire payload was `{"adapter":"RedisQueue"}`. This is the
   * DURABLE half of the fix; `queue_jobs_total` is per-process and resets on
   * restart, so a restarted replica would report zero dead letters while the
   * backend still held them.
   *
   * The key is OMITTED, never reported as an empty object or as zeros, when the
   * adapter cannot count: "cannot report" and "nothing there" are different
   * answers and an operator acting on a dead-letter alert needs to tell them
   * apart. A failing count is reported and skipped rather than taking the whole
   * probe down — a health check that throws is worse than one missing a field.
   *
   * @returns `{ queues }` keyed by job name, or `{}` when unavailable
   */
  async #collectDepths(): Promise<Record<string, unknown>> {
    const readDepths = this.#adapter.depths;
    if (typeof readDepths !== 'function' || this.#processors.size === 0) {
      return {};
    }
    const queues: Record<string, QueueDepths> = {};
    for (const name of this.#processors.keys()) {
      try {
        queues[name] = await readDepths.call(this.#adapter, name);
      } catch (error) {
        this.#report('queue depth probe failed', error, { name });
      }
    }
    return Object.keys(queues).length === 0 ? {} : { queues };
  }

  #startWorkerLoop(): void {
    this.#workerHandle = this.#runtime.setInterval(() => {
      // The loop must survive a transient adapter failure, but the failure is
      // reported rather than discarded.
      this.#poll().catch((error: unknown) => {
        this.#report('queue poll failed', error);
      });
    }, this.#pollIntervalMs);
  }

  #startRecurringLoop(): void {
    this.#recurringHandle = this.#runtime.setInterval(() => {
      this.#processRecurring().catch((error: unknown) => {
        this.#report('queue recurring scheduling failed', error);
      });
    }, this.#pollIntervalMs);
  }

  async #poll(): Promise<void> {
    const now = this.#runtime.now();

    for (const [name, reg] of this.#processors.entries()) {
      // Skip if reserve is already in progress for this name
      if (reg.reserveInProgress) {
        continue;
      }

      // Skip if at concurrency limit
      if (reg.inFlight >= reg.concurrency) {
        continue;
      }

      // Compute how many jobs we can reserve
      const limit = reg.concurrency - reg.inFlight;

      // Mark reserve as in progress
      reg.reserveInProgress = true;

      try {
        const jobs = await this.#adapter.reserve<unknown>(name, limit, now);

        for (const storedJob of jobs) {
          // Increment in-flight counter
          reg.inFlight++;

          // Update job attempts to 1 (first delivery)
          const jobWithAttempts: StoredJob<unknown> = {
            ...storedJob,
            attempts: storedJob.attempts === 0 ? 1 : storedJob.attempts,
          };

          // Dispatch job
          this.#dispatchJob(jobWithAttempts, reg as ProcessorRegistration<unknown>);
        }
      } finally {
        reg.reserveInProgress = false;
      }
    }
  }

  #dispatchJob<T>(
    storedJob: StoredJob<T>,
    reg: ProcessorRegistration<T>,
  ): void {
    const processor = async () => {
      try {
        await runJob<T>(
          this.#runtime,
          this.#adapter,
          storedJob,
          reg.processor,
          (message, error, meta) => this.#report(message, error, meta),
          {
            ...(reg.onFailed === undefined ? {} : { onFailed: reg.onFailed }),
            onOutcome: (name: string, outcome: JobOutcome) =>
              this.#collector?.jobSettled(name, outcome),
          },
        );
      } finally {
        // Decrement in-flight when the job settles
        reg.inFlight--;
      }
    };

    // Fire and forget. runJob handles a failing processor, but a failing adapter
    // call (ack / requeue / deadLetter) still rejects, and this promise is not
    // awaited: without a catch that rejection escapes and terminates the process.
    // The catch must NOT decrement inFlight — the finally above already did.
    processor().catch((error: unknown) => {
      this.#report('queue job settlement failed', error, {
        job: storedJob.id,
        name: storedJob.name,
      });
    });
  }

  async #processRecurring(): Promise<void> {
    const now = this.#runtime.now();

    const due = await this.#adapter.fetchRecurringDue(now);

    for (const rec of due) {
      // Enqueue a concrete job
      await this.#adapter.enqueue({
        id: this.#runtime.uuid(),
        name: rec.name,
        data: rec.data,
        attempts: 0,
        maxAttempts: this.#defaultMaxAttempts,
        availableAtMs: now,
      });

      // Advance the recurring schedule
      try {
        const nextRunAtMs = cronNextMs(rec.cron, now);
        await this.#adapter.advanceRecurring(rec.id, nextRunAtMs);
      } catch {
        // Skip invalid cron expressions (should not happen if stored correctly)
      }
    }
  }
}
