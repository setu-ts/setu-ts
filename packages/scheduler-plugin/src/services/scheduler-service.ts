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
} from '@setu-ts/common';
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
   *
   * The first fire is grid-aligned: it lands on the next epoch multiple of
   * the interval rather than a full interval after registration, so replicas
   * registered at different instants compute IDENTICAL fire times and agree
   * on distributed-lock slot keys (M70l). The period is unchanged; only the
   * phase moves, and never later than `intervalMs` after registration.
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
    const nextRunAtMs = this.#gridAlignedNextRun(now, intervalMs);

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
    // F1: arm for the delay to the grid boundary, not a full interval.
    this.#armTimer(entry);
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
      slotClaimed: false,
      slotToken: null,
      ...(options?.data !== undefined ? { data: options.data as unknown } : {}),
      ...(options?.retry !== undefined ? { retry: options.retry } : {}),
    };

    this.#registry.add(entry);
    // F2: claim the fire slot at REGISTRATION, not at fire time. A delay's
    // `nextRunAtMs` is `now + delayMs`, which carries per-replica startup
    // skew — two replicas registering the same delay 700 ms apart would
    // compute different fire times and a fire-time key on `nextRunAtMs`
    // would never collide. The slot is therefore keyed on the job NAME
    // (skew-independent): the first registration claims it, a later
    // replica's registration finds it held and marks its entry
    // not-claimed, so exactly one replica runs the handler when the
    // timers fire. The slot is released when the entry leaves the
    // registry (fire, `remove`, or the lock's own ttl expiry), so a
    // re-registration under the same name gets a fresh slot.
    await this.#claimDelaySlot(entry);
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
        nextRunAtMs = this.#gridAlignedNextRun(now, entry.intervalMs);
        break;
      case 'delay':
        nextRunAtMs = now + entry.delayMs;
        break;
    }

    // C1 FIX: Assign nextRunAtMs BEFORE arming the timer so #armTimer uses the fresh value
    entry.nextRunAtMs = nextRunAtMs;

    const timerHandle = this.#armTimer(entry);

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
    // F2: a delay entry leaving the registry through remove() releases its
    // registration-time slot, so the name can be re-registered fresh.
    if (entry.kind === 'delay') {
      await this.#releaseDelaySlot(entry);
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

  /**
   * Arms the timer for the delay to `entry.nextRunAtMs`, for every kind.
   *
   * F1: an `every` entry must NOT be armed for a full `intervalMs` — its
   * `nextRunAtMs` is grid-aligned (§3.3), so arming for the interval would
   * run the job one full interval LATER than the boundary it was aligned to,
   * defeating the grid alignment entirely. The delay is
   * `Math.max(0, nextRunAtMs - now)`: the distance to the intended fire
   * (the next epoch grid boundary for `every`), never later than that
   * boundary and never negative for a timer armed after its time passed.
   */
  #armTimer(entry: RegistryEntry<unknown>): TimerHandle {
    const now = this.#runtime.now();
    const delay = Math.max(0, entry.nextRunAtMs - now);

    const handle = this.#runtime.setTimeout(async () => {
      await this.#fire(entry);
    }, delay);

    entry.timerHandle = handle;
    return handle;
  }

  /**
   * The next grid-aligned fire time for an `every` job.
   *
   * `(floor(now / interval) + 1) * interval` — the first epoch multiple of
   * the interval strictly after `now`. Two replicas started any distance
   * apart compute the SAME value in the same tick, which is what makes the
   * slot key in {@linkcode #fire} collide across replicas (M70l §3.3).
   *
   * @param now - The current runtime time in epoch ms
   * @param intervalMs - The job's fixed interval
   * @returns The next epoch-multiple fire time
   */
  #gridAlignedNextRun(now: number, intervalMs: number): number {
    return (Math.floor(now / intervalMs) + 1) * intervalMs;
  }

  /**
   * The fire-slot key for a `delay` entry.
   *
   * F2: keyed on the job NAME, never on `nextRunAtMs`. A delay's intended
   * fire time is `now + delayMs`, which carries per-replica startup skew —
   * two replicas registering the same delay 700 ms apart would compute
   * different instants, and a fire-time key on the instant would never
   * collide, so both replicas would run. The name is what identifies "the
   * same one-shot job" across replicas, and it is skew-independent.
   *
   * The `:once` suffix keeps the slot distinct from the per-handler
   * OVERLAP mutex, which is keyed `scheduler:job:<name>`: the slot is held
   * from registration until the fire settles, and a bare-name key would
   * make the mutex acquire at fire time always lose to the slot's own
   * claim.
   */
  #delaySlotKey(entry: DelayRegistryEntry<unknown>): string {
    return `scheduler:job:${entry.name}:once`;
  }

  /**
   * Claims the fire slot for a `delay` entry at REGISTRATION time (F2).
   *
   * The claim happens here, not in {@linkcode #fire}, because the dedup must
   * be decided before either replica's timer fires: the first registration
   * claims the name slot, a later replica's registration finds it held and
   * marks its entry not-claimed, so exactly one replica runs the handler
   * when the timers fire. The slot lives for the entry's whole life — the
   * delay itself plus the handler's worst-case runtime (`ttlMs`) — and is
   * released when the entry leaves the registry ({@linkcode #fire},
   * {@linkcode remove}), so a re-registration under the same name gets a
   * fresh slot. A lock failure is treated as not-claimed (skip the run),
   * never as a reason to drop the schedule.
   */
  async #claimDelaySlot(entry: DelayRegistryEntry<unknown>): Promise<void> {
    const slotKey = this.#delaySlotKey(entry);
    try {
      const token = await this.#lock.acquire(slotKey, this.#ttlMs + entry.delayMs);
      if (token === null) {
        // Another replica registered this delay first; its fire runs the
        // handler. This replica keeps its armed timer (it must still leave
        // the registry cleanly) but skips the run.
        entry.slotClaimed = false;
        return;
      }
      entry.slotToken = token;
      entry.slotClaimed = true;
    } catch (error) {
      // Lock backend unreachable — treat as not-claimed rather than risk a
      // duplicate run; the schedule is kept, the run is skipped.
      this.#logger?.error(`Job '${entry.name}': could not claim fire slot`, {
        error: error instanceof Error ? error.message : String(error),
      });
      entry.slotClaimed = false;
    }
  }

  /**
   * Releases the fire slot a `delay` entry claimed at registration (F2).
   *
   * Called on every path by which a delay entry leaves the registry. A
   * failed release is contained: the slot expires on its own TTL, and a
   * release failure must never kill the job.
   */
  async #releaseDelaySlot(entry: DelayRegistryEntry<unknown>): Promise<void> {
    if (entry.slotToken === null) {
      return; // This entry never held the slot — nothing to release.
    }
    const slotKey = this.#delaySlotKey(entry);
    try {
      await this.#lock.release(slotKey, entry.slotToken);
    } catch (error) {
      this.#logger?.error(`Job '${entry.name}': could not release fire slot`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Acquire the handler-mutex lock, run the handler, and release — containing
   * every failure.
   *
   * This lock is the OVERLAP mutex: it skips a fire whose predecessor of the
   * same job is still running. Per-fire dedup across replicas is a separate
   * guarantee, owned by the never-released slot lock in {@linkcode #fire}
   * (M70l C3): slot N+1 is a different key from slot N, so this mutex cannot
   * see it — and dedup cannot see a still-running previous fire. Two locks,
   * because they answer two different questions.
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
      // Another instance holds the handler mutex — a previous fire of this
      // same job is still running there. This is overlap protection, NOT
      // per-fire dedup; that is the slot lock's job (M70l C3).
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

    // The fire-slot lock — per-fire dedup across replicas (X10-2), distinct
    // from the per-handler overlap mutex below. The keying differs by kind
    // because the two kinds of "same fire" are different:
    //
    // `cron`/`every`: keyed on the time this fire was INTENDED for
    // (`nextRunAtMs`, grid-aligned by §3.3), acquired HERE at fire time,
    // never released, and expired by the shared ttlMs. Two replicas whose
    // timers land anywhere in the same intended slot therefore agree that
    // exactly ONE of them runs: the second `acquire` returns null and the
    // fire is skipped locally while the local schedule still re-arms below.
    // Keying on the intended instant rather than `runtime.now()` makes the
    // slot immune to timer jitter — `#armTimer` uses
    // `Math.max(0, nextRunAtMs - now)`, so a late timer still computes the
    // slot it was armed for.
    //
    // `delay` (F2): keyed on the job NAME and claimed at REGISTRATION time
    // in `delay()` — see {@linkcode #claimDelaySlot}. The name is what
    // identifies "the same one-shot job" across replicas; `nextRunAtMs`
    // cannot be the key because it carries per-replica skew. The slot is
    // released when the entry leaves the registry, so re-registration gets
    // a fresh slot.
    let slotClaimed: boolean;
    if (entry.kind === 'delay') {
      slotClaimed = entry.slotClaimed;
      if (!slotClaimed) {
        // Another replica registered this delay first and will run it.
        this.#logger?.debug(
          `Job '${entry.name}': fire slot claimed by another instance, skipping`,
        );
      }
    } else {
      const slotKey = `scheduler:job:${entry.name}:${String(entry.nextRunAtMs)}`;
      slotClaimed = true;
      try {
        const slotToken = await this.#lock.acquire(slotKey, this.#ttlMs);
        if (slotToken === null) {
          // Another replica claimed this exact fire. Skip the run — but keep
          // the local re-arm logic below, or this replica would silently stop
          // scheduling after the first contended tick.
          this.#logger?.debug(
            `Job '${entry.name}': fire slot already claimed by another instance, skipping`,
          );
          slotClaimed = false;
        }
      } catch (error) {
        // Lock backend unreachable — treat as unclaimed-but-unprovable and skip
        // the run rather than risk a duplicate; the schedule still re-arms.
        this.#logger?.error(`Job '${entry.name}': could not claim fire slot`, {
          error: error instanceof Error ? error.message : String(error),
        });
        slotClaimed = false;
      }
    }

    const lockKey = `scheduler:job:${entry.name}`;

    // Skipping a fire must never cancel the schedule: a contended lock is the
    // NORMAL multi-instance path, and a lock backend blip is transient. Every
    // lock failure below is contained here so the re-arm logic still runs.
    if (slotClaimed) {
      await this.#runWithLock(entry, lockKey);
    }

    // One-shot delay jobs are removed after firing, regardless of pause state.
    if (entry.kind === 'delay') {
      // F2: the entry is leaving the registry — release the slot it claimed
      // at registration so a later re-registration under the same name gets
      // a fresh slot. (No-op when this entry never held it.)
      await this.#releaseDelaySlot(entry);
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
      entry.nextRunAtMs = this.#gridAlignedNextRun(this.#runtime.now(), entry.intervalMs);
      // F1: re-arm for the delay to the NEXT grid boundary, not a full
      // interval — the boundary is what `nextRunAtMs` already points at.
      this.#armTimer(entry);
    }
  }
}
