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
import type {
  CronRegistryEntry,
  DelayRegistryEntry,
  EveryRegistryEntry,
  IDistributedLock,
  RegistryEntry,
} from '../interfaces/index.ts';
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

    const entry: CronRegistryEntry<unknown> = {
      name,
      kind: 'cron',
      expression,
      handler: handler as SchedulerJobHandler<unknown>,
      paused: false,
      nextRunAtMs,
      timerHandle: null,
      generation: 0,
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

    const entry: EveryRegistryEntry<unknown> = {
      name,
      kind: 'every',
      intervalMs,
      handler: handler as SchedulerJobHandler<unknown>,
      paused: false,
      nextRunAtMs,
      timerHandle: null,
      generation: 0,
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

    const entry: DelayRegistryEntry<unknown> = {
      name,
      kind: 'delay',
      delayMs,
      handler: handler as SchedulerJobHandler<unknown>,
      paused: false,
      nextRunAtMs,
      timerHandle: null,
      generation: 0,
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
    // Exhaustive over the `RegistryEntry` discriminated union: TypeScript
    // guarantees `nextRunAtMs` is assigned in every case, so no `default`
    // arm is needed (or reachable).
    switch (entry.kind) {
      case 'cron':
        nextRunAtMs = cronNextMs(entry.expression, now);
        break;
      case 'every':
        nextRunAtMs = now + entry.intervalMs;
        break;
      case 'delay':
        nextRunAtMs = now + entry.delayMs;
        break;
    }

    // C1 FIX: Assign nextRunAtMs BEFORE arming the timer so #armTimer uses the fresh value
    entry.nextRunAtMs = nextRunAtMs;

    const timerHandle = entry.kind === 'every' ? this.#armInterval(entry) : this.#armTimer(entry);

    entry.paused = false;
    // C4 FIX: Increment generation to prevent double-fire if pause()+resume() fires during an in-flight job
    entry.generation = (entry.generation ?? 0) + 1;
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

    const handle = this.#runtime.setTimeout(async () => {
      await this.#fire(entry);
    }, delay);

    entry.timerHandle = handle;
    return handle;
  }

  #armInterval(entry: EveryRegistryEntry<unknown>): TimerHandle {
    const delay = entry.intervalMs;

    const handle = this.#runtime.setTimeout(async () => {
      await this.#fire(entry);
    }, delay);

    entry.timerHandle = handle;
    return handle;
  }

  /**
   * Acquire the lock, run the handler, and release — containing every failure.
   *
   * A `null` token (another instance holds the lock) and a rejecting
   * `acquire`/`release` are all skip-this-fire conditions, never
   * cancel-the-schedule conditions, so this never throws to the caller.
   */
  async #runWithLock(entry: RegistryEntry<unknown>, lockKey: string): Promise<void> {
    let token: string | null;
    try {
      token = await this.#lock.acquire(lockKey, this.#ttlMs);
    } catch (error) {
      // Lock backend unreachable — skip this fire, keep the schedule.
      this.#logger?.error(`Job '${entry.name}': could not acquire lock`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (token === null) {
      // Another instance holds the lock — it is running this fire.
      this.#logger?.debug(`Job '${entry.name}': lock held elsewhere, skipping this fire`);
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
    } catch (error) {
      // Handler exhausted retries — log but do not crash the scheduler loop.
      this.#logger?.error(`Job '${entry.name}' failed permanently`, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        await this.#lock.release(lockKey, token);
      } catch (error) {
        // The lock expires on its own TTL — a failed release must not kill the job.
        this.#logger?.error(`Job '${entry.name}': could not release lock`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async #fire(entry: RegistryEntry<unknown>): Promise<void> {
    // C4 FIX: Capture generation at fire START to detect if pause()+resume() fires during await
    const fireGen = entry.generation ?? 0;

    const lockKey = `scheduler:job:${entry.name}`;

    // Skipping a fire must never cancel the schedule: a contended lock is the
    // NORMAL multi-instance path, and a lock backend blip is transient. Every
    // lock failure below is contained here so the re-arm logic still runs.
    await this.#runWithLock(entry, lockKey);

    // One-shot delay jobs are removed after firing, regardless of pause state.
    if (entry.kind === 'delay') {
      // C6 FIX: Guard against mid-fire remove() — if remove() was called while
      // the handler was in flight, the entry is already gone; skip removing again.
      if (this.#registry.has(entry.name)) {
        this.#registry.remove(entry.name);
        this.#names.delete(entry.name);
      }
      return;
    }

    // C3 FIX: Guard for disconnect() — if service disconnected while fire was in flight,
    // do not re-arm a new timer.
    if (!this.#connected) {
      return;
    }

    // C3 FIX: Guard for remove() — if entry was removed while fire was in flight,
    // do not re-arm.
    if (!this.#registry.has(entry.name)) {
      return;
    }

    // If the job was paused while this fire was in flight (across the lock /
    // handler awaits), do not re-arm — resume() arms a fresh timer instead.
    if (entry.paused) {
      return;
    }

    // C4 FIX: Re-check generation — if it changed, a resume() armed a new timer; skip.
    if (entry.generation !== fireGen) {
      // Generation changed due to pause()+resume() during this fire.
      // The resume() already armed a new timer, so skip re-arming here.
      // Reset generation to allow normal re-arming on the NEXT fire.
      entry.generation = fireGen;
      return;
    }

    if (entry.kind === 'cron') {
      entry.nextRunAtMs = cronNextMs(entry.expression, this.#runtime.now());
      this.#armTimer(entry);
    } else {
      entry.nextRunAtMs = this.#runtime.now() + entry.intervalMs;
      this.#armInterval(entry);
    }
  }
}
