// deno-lint-ignore-file require-await
/**
 * Scheduler service implementation.
 *
 * Implements `IScheduler` with in-process, runtime-timer-driven
 * execution supporting cron, every (fixed-interval), and delay
 * (one-shot) jobs with retry, distributed locking, pause/resume/remove.
 *
 * Mirrors the QueueService precedent: `connect()` arms timers,
 * `disconnect()` clears them, `createHealthIndicator()` returns
 * the health check function.
 *
 * @module
 */
import type {
  HealthCheckResult,
  HealthIndicatorFn,
  ILogger,
  IRuntimeServices,
  IScheduler,
  ScheduleOptions,
  SchedulerJobHandler,
  TimerHandle,
} from '@hono-enterprise/common';
import type { IDistributedLock, RegistryEntry } from '../interfaces/index.ts';
import { cronNextMs } from '../cron/cron-parser.ts';
import { JobRegistry } from '../jobs/job-registry.ts';
import { run } from '../jobs/job-executor.ts';

/**
 * Scheduler service implementing IScheduler.
 *
 * Owns the job registry, timer arming, job executor, and distributed
 * lock. All times come from `runtime.now()`, all timers from
 * `runtime.set*` / `runtime.clear*`.
 */
export class SchedulerService implements IScheduler {
  #registry: JobRegistry;
  #runtime: IRuntimeServices;
  #lock: IDistributedLock;
  #logger: ILogger | undefined;
  #ttlMs: number;
  #connected = false;
  #names: Set<string> = new Set();

  constructor(
    runtime: IRuntimeServices,
    lock: IDistributedLock,
    options?: { logger?: ILogger | undefined; ttlMs?: number | undefined },
  ) {
    this.#registry = new JobRegistry();
    this.#runtime = runtime;
    this.#lock = lock;
    this.#logger = options?.logger;
    this.#ttlMs = options?.ttlMs ?? 30000;
  }

  /**
   * Connect the service (start accepting schedules).
   */
  async connect(): Promise<void> {
    this.#connected = true;
  }

  /**
   * Disconnect the service (clear all timers and stop).
   */
  async disconnect(): Promise<void> {
    this.#connected = false;

    for (const name of this.#names) {
      try {
        const entry = this.#registry.get(name);
        if (entry.timerHandle !== null) {
          this.#runtime.clearTimeout(entry.timerHandle);
        }
      } catch {
        // ignore — entry may have been removed during disconnect
      }
    }
    this.#names.clear();
  }

  /**
   * Check if the service is ready.
   */
  isReady(): boolean {
    return this.#connected;
  }

  /**
   * Create a health indicator function.
   */
  createHealthIndicator(): HealthIndicatorFn {
    return async (): Promise<HealthCheckResult> => {
      const connected = this.#connected;
      return {
        status: connected ? 'up' : 'down',
        data: {
          connected,
        },
      };
    };
  }

  /**
   * Schedule a recurring job using a 5-field cron expression (UTC).
   */
  async cron<T = unknown>(
    name: string,
    expression: string,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void> {
    if (!this.#connected) {
      throw new Error('SchedulerService is not connected');
    }

    const now = this.#runtime.now();
    const nextRunAtMs = cronNextMs(expression, now);

    const entry: RegistryEntry<unknown> = {
      name,
      kind: 'cron',
      expression,
      handler: handler as SchedulerJobHandler<unknown>,
      paused: false,
      nextRunAtMs,
      timerHandle: null,
      ...(options?.data !== undefined ? { data: options.data as unknown } : {}),
      ...(options?.retry !== undefined ? { retry: options.retry } : {}),
    };

    this.#registry.add(entry);
    this.#names.add(name);
    this.#armTimer(entry);
  }

  /**
   * Schedule a recurring job that fires every `intervalMs` milliseconds.
   */
  async every<T = unknown>(
    name: string,
    intervalMs: number,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void> {
    if (!this.#connected) {
      throw new Error('SchedulerService is not connected');
    }

    const now = this.#runtime.now();
    const nextRunAtMs = now + intervalMs;

    const entry: RegistryEntry<unknown> = {
      name,
      kind: 'every',
      intervalMs,
      handler: handler as SchedulerJobHandler<unknown>,
      paused: false,
      nextRunAtMs,
      timerHandle: null,
      ...(options?.data !== undefined ? { data: options.data as unknown } : {}),
      ...(options?.retry !== undefined ? { retry: options.retry } : {}),
    };

    this.#registry.add(entry);
    this.#names.add(name);
    this.#armInterval(entry);
  }

  /**
   * Schedule a one-shot delayed job.
   */
  async delay<T = unknown>(
    name: string,
    delayMs: number,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void> {
    if (!this.#connected) {
      throw new Error('SchedulerService is not connected');
    }

    const now = this.#runtime.now();
    const nextRunAtMs = now + delayMs;

    const entry: RegistryEntry<unknown> = {
      name,
      kind: 'delay',
      delayMs,
      handler: handler as SchedulerJobHandler<unknown>,
      paused: false,
      nextRunAtMs,
      timerHandle: null,
      ...(options?.data !== undefined ? { data: options.data as unknown } : {}),
      ...(options?.retry !== undefined ? { retry: options.retry } : {}),
    };

    this.#registry.add(entry);
    this.#names.add(name);
    this.#armTimer(entry);
  }

  /**
   * Pause a scheduled job.
   */
  async pause(name: string): Promise<void> {
    this.#registry.pause(name, (handle) => {
      this.#runtime.clearTimeout(handle);
    });
  }

  /**
   * Resume a paused job.
   */
  async resume(name: string): Promise<void> {
    const entry = this.#registry.get(name);
    if (!entry.paused) {
      // Idempotent — already running
      return;
    }

    const now = this.#runtime.now();

    let nextRunAtMs: number;
    switch (entry.kind) {
      case 'cron':
        if (entry.expression === undefined) {
          throw new Error(`Job '${name}' has no cron expression`);
        }
        nextRunAtMs = cronNextMs(entry.expression, now);
        break;
      case 'every':
        nextRunAtMs = now + (entry.intervalMs ?? 0);
        break;
      case 'delay':
        nextRunAtMs = now + (entry.delayMs ?? 0);
        break;
      default:
        throw new Error(`Unknown job kind: ${entry.kind}`);
    }

    const timerHandle = entry.kind === 'every' ? this.#armInterval(entry) : this.#armTimer(entry);

    entry.paused = false;
    entry.nextRunAtMs = nextRunAtMs;
    entry.timerHandle = timerHandle;
  }

  /**
   * Remove a scheduled job entirely.
   */
  async remove(name: string): Promise<void> {
    const entry = this.#registry.get(name);
    if (entry.timerHandle !== null) {
      this.#runtime.clearTimeout(entry.timerHandle);
    }
    this.#registry.remove(name);
    this.#names.delete(name);
  }

  /**
   * Return the next scheduled fire time.
   */
  async getNextRun(name: string): Promise<number> {
    return this.#registry.getNextRun(name);
  }

  // --- Internal helpers ---

  #armTimer(entry: RegistryEntry<unknown>): TimerHandle {
    const now = this.#runtime.now();
    const delay = Math.max(0, entry.nextRunAtMs - now);

    const handle = this.#runtime.setTimeout(() => {
      void this.#fire(entry);
    }, delay);

    entry.timerHandle = handle;
    return handle;
  }

  #armInterval(entry: RegistryEntry<unknown>): TimerHandle {
    const delay = entry.intervalMs ?? 1000;

    const handle = this.#runtime.setTimeout(() => {
      void this.#fire(entry);
      if (entry.kind === 'every' && !entry.paused) {
        entry.nextRunAtMs = this.#runtime.now() + delay;
        this.#armInterval(entry);
      }
    }, delay);

    entry.timerHandle = handle;
    return handle;
  }

  async #fire(entry: RegistryEntry<unknown>): Promise<void> {
    if (entry.paused) {
      return;
    }

    const lockKey = `scheduler:job:${entry.name}`;
    const token = await this.#lock.acquire(lockKey, this.#ttlMs);

    if (token === null) {
      // Another instance holds the lock — skip this fire
      return;
    }

    try {
      const jobId = this.#runtime.uuid();
      await run(
        jobId,
        entry.name,
        entry.handler,
        entry.data,
        entry.retry,
        { runtime: this.#runtime, logger: this.#logger },
      );
    } finally {
      await this.#lock.release(lockKey, token);
    }

    // For delay (one-shot) jobs: remove after fire
    if (entry.kind === 'delay') {
      this.#registry.remove(entry.name);
      this.#names.delete(entry.name);
      // Re-arm for cron
    } else if (entry.kind === 'cron' && !entry.paused) {
      entry.nextRunAtMs = cronNextMs(entry.expression!, this.#runtime.now());
      this.#armTimer(entry);
    }
  }
}
