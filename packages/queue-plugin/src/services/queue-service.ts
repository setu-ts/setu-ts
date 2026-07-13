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
  IQueue,
  JobProcessor,
  ProcessOptions,
  RecurringOptions,
} from '@hono-enterprise/common';
import type { HealthIndicatorFn, IRuntimeServices } from '@hono-enterprise/common';
import type { QueueAdapter } from '../adapters/queue-adapter.ts';
import type { StoredJob, StoredRecurring } from '../interfaces/index.ts';
import { runJob } from '../processors/job-processor.ts';
import { cronNextMs } from '../scheduler/cron-calculator.ts';

/**
 * Internal processor registration.
 */
interface ProcessorRegistration<T> {
  processor: JobProcessor<T>;
  concurrency: number;
  inFlight: number;
  reserveInProgress: boolean;
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
  #workerHandle: number | null = null;
  #recurringHandle: number | null = null;
  #connected = false;

  constructor(
    adapter: QueueAdapter,
    runtime: IRuntimeServices,
    options?: { defaultMaxAttempts?: number; pollIntervalMs?: number },
  ) {
    this.#adapter = adapter;
    this.#runtime = runtime;
    this.#defaultMaxAttempts = options?.defaultMaxAttempts ?? 3;
    this.#pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.#processors = new Map();
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
   */
  createHealthIndicator(): HealthIndicatorFn {
    return (): Promise<HealthCheckResult> => {
      const isReady = this.isReady();
      return Promise.resolve({
        status: isReady ? 'up' : 'down',
        data: { adapter: this.#adapter.constructor.name },
      });
    };
  }

  #startWorkerLoop(): void {
    this.#workerHandle = this.#runtime.setInterval(() => {
      this.#poll();
    }, this.#pollIntervalMs) as unknown as number;
  }

  #startRecurringLoop(): void {
    this.#recurringHandle = this.#runtime.setInterval(() => {
      this.#processRecurring();
    }, this.#pollIntervalMs) as unknown as number;
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

      if (limit <= 0) {
        continue;
      }

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
          this.#dispatchJob(name, jobWithAttempts, reg as ProcessorRegistration<unknown>);
        }
      } finally {
        reg.reserveInProgress = false;
      }
    }
  }

  #dispatchJob<T>(
    _name: string,
    storedJob: StoredJob<T>,
    reg: ProcessorRegistration<T>,
  ): void {
    const processor = async () => {
      try {
        await runJob<T>(this.#runtime, this.#adapter, storedJob, reg.processor);
      } finally {
        // Decrement in-flight when job settles
        reg.inFlight--;
      }
    };

    // Fire and forget - errors are handled by runJob
    processor().catch(() => {
      // Errors are already handled in runJob (requeue/deadLetter)
      reg.inFlight--;
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
