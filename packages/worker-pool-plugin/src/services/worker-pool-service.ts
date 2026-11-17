/**
 * WorkerPoolService — implements {@linkcode IWorkerPool} over lazily-created
 * per-task-module {@linkcode TaskPool}s.
 *
 * @module
 */

import type {
  IRuntimeServices,
  IWorkerHost,
  IWorkerPool,
  TaskPoolStats,
  WorkerRunOptions,
} from '@setu-ts/common';
import type { WorkerPoolPluginOptions } from '../interfaces/index.ts';
import { WorkerPoolUnavailableError } from '../errors.ts';
import { TaskPool } from '../pool/task-pool.ts';
import { WorkerBudget } from '../pool/worker-budget.ts';
import { assertTaskTimeout, readSizingOptions, resolveMaxWorkers } from './sizing.ts';
import type { SizingSnapshot } from './sizing.ts';
import type { WorkerPoolCollector } from '../metrics/worker-pool-collector.ts';
import { TaskLabels } from '../metrics/task-label.ts';

/** Default pending-queue bound per pool. */
const DEFAULT_MAX_QUEUE = 1024;
/** Default task timeout in milliseconds (`0` disables). */
const DEFAULT_TASK_TIMEOUT_MS = 30_000;

const budgetLimits = new WeakMap<WorkerPoolService, number>();
const unsettledErrorReporters = new WeakMap<
  WorkerPoolService,
  (taskModule: string, error: Error) => void
>();

/**
 * Internal: lets the plugin route worker errors that settled no task to its
 * logger. Deliberately absent from the public barrel.
 *
 * @param service - The service whose pools report through `reporter`
 * @param reporter - Receives the task module and the worker error
 */
export function setUnsettledErrorReporter(
  service: WorkerPoolService,
  reporter: (taskModule: string, error: Error) => void,
): void {
  unsettledErrorReporters.set(service, reporter);
}

const taskLabels = new WeakMap<WorkerPoolService, TaskLabels>();

/**
 * Internal: the operator-facing label for a task module, assigned on first
 * sight. Kept off the exported class so it adds no public surface.
 *
 * @param service - The service that owns the labels
 * @param taskModule - The task-module specifier
 * @returns Its label for `/metrics` and `/health`
 */
export function taskLabelOf(service: WorkerPoolService, taskModule: string): string {
  return taskLabels.get(service)!.labelOf(taskModule);
}

const labelCollisionReporters = new WeakMap<
  WorkerPoolService,
  (specifier: string, label: string) => void
>();

/**
 * Internal: lets the plugin warn when a derived task label was already taken
 * and the pool got a suffixed one. Deliberately absent from the public barrel.
 *
 * @param service - The service whose labels report through `reporter`
 * @param reporter - Receives the specifier and the label it got instead
 */
export function setLabelCollisionReporter(
  service: WorkerPoolService,
  reporter: (specifier: string, label: string) => void,
): void {
  labelCollisionReporters.set(service, reporter);
}

/** One pool's state as it leaves the process: labelled, with no specifier. */
export interface LabelledPoolStats {
  /** The pool's task label (never its specifier). */
  readonly task: string;
  /** Workers currently alive in the pool. */
  readonly workers: number;
  /** Workers currently executing a task. */
  readonly busy: number;
  /** Tasks waiting in the pool's queue. */
  readonly queued: number;
  /** Tasks completed successfully since the pool was created. */
  readonly completed: number;
  /** Tasks failed (error, crash, or timeout) since the pool was created. */
  readonly failed: number;
}

/**
 * Internal health accessor: every pool's stats under its task label. The
 * specifier stays in-process (`stats()`); this is what `/health` publishes.
 *
 * @param service - The service to read
 * @returns One labelled snapshot per pool
 */
export function labelledStatsOf(service: WorkerPoolService): readonly LabelledPoolStats[] {
  return service.stats().map(({ taskModule, ...counts }) => ({
    task: taskLabelOf(service, taskModule),
    ...counts,
  }));
}

/** Internal health accessor; deliberately absent from the public barrel. */
export function budgetLimitOf(service: WorkerPoolService): number {
  return budgetLimits.get(service)!;
}

/**
 * The worker pool service registered under `CAPABILITIES.WORKER_POOL`.
 *
 * Resolves the worker host once: an injected `options.host` wins over the
 * runtime's `IRuntimeServices.workers`. When neither exists (e.g. Cloudflare
 * Workers), the service still constructs — `run()` throws
 * {@linkcode WorkerPoolUnavailableError}, `stats()` returns `[]`, and
 * `shutdown()` resolves — so one codebase stays deployable everywhere.
 * Construction refuses an invalid `maxWorkers` with `RangeError`, just as
 * the plugin factory does.
 *
 * @since 0.1.0
 */
export class WorkerPoolService implements IWorkerPool {
  private readonly host: IWorkerHost | undefined;
  private readonly pools = new Map<string, TaskPool>();
  private readonly budget: WorkerBudget;
  private readonly sizing: SizingSnapshot;
  private closed = false;

  constructor(
    options: WorkerPoolPluginOptions | undefined,
    private readonly runtime: IRuntimeServices,
    /**
     * Present only when the application registered `CAPABILITIES.METRICS`.
     * Threaded into every pool this service creates.
     */
    private readonly collector?: WorkerPoolCollector | undefined,
  ) {
    this.sizing = readSizingOptions(options);
    taskLabels.set(
      this,
      new TaskLabels(this.sizing.labels, (specifier, label) => {
        // Reporting a renamed label must never fail the run() that caused it:
        // a throwing logger would otherwise surface as a synchronous throw from
        // a Promise-returning method.
        try {
          labelCollisionReporters.get(this)?.(specifier, label);
        } catch {
          // The label is assigned either way; only the warning is lost.
        }
      }),
    );
    this.host = options?.host ?? runtime.workers;
    const limit = resolveMaxWorkers(this.sizing, this.host?.availableParallelism() ?? 0);
    this.budget = new WorkerBudget(limit);
    budgetLimits.set(this, limit);
  }

  /**
   * Runs a task on the pool for `taskModule`, creating it lazily.
   *
   * @param taskModule - Module specifier of a `defineWorkerTask` module
   * @param input - Structured-clonable task input
   * @param options - Per-call options
   * @returns The task's output
   * @throws {WorkerPoolUnavailableError} When the runtime has no worker
   * support
   * @throws {RangeError} When `options.timeoutMs` is not `0` or a positive
   * integer no greater than 2 147 483 647 (the call is rejected, not admitted)
   */
  run<TInput, TOutput>(
    taskModule: string,
    input: TInput,
    options?: WorkerRunOptions,
  ): Promise<TOutput> {
    // Read once: the value checked is the value the pool uses.
    const timeoutMs: unknown = options?.timeoutMs;
    try {
      assertTaskTimeout(timeoutMs, 'timeoutMs');
    } catch (error) {
      // Refused before admission and before any pool exists. Not counted in
      // worker_pool_tasks_rejected_total: that series' reasons describe pool
      // state, and an invalid argument says nothing about the pool.
      return Promise.reject(error);
    }
    if (this.closed) {
      this.collector?.taskRejected(taskLabelOf(this, taskModule), 'pool_closed');
      return Promise.reject(new WorkerPoolUnavailableError('Worker pool has been shut down'));
    }
    const host = this.host;
    if (host === undefined) {
      // No pool exists to report through, so the rejection is recorded here.
      // On a runtime without threads (Cloudflare Workers) this series is the
      // only signal that work was attempted at all.
      this.collector?.taskRejected(taskLabelOf(this, taskModule), 'unavailable');
      return Promise.reject(new WorkerPoolUnavailableError());
    }
    let pool = this.pools.get(taskModule);
    if (pool === undefined) {
      pool = new TaskPool(
        this.resolveConfig(taskModule, host),
        host,
        this.runtime,
        this.budget,
        this.collector,
        (error) => unsettledErrorReporters.get(this)?.(taskModule, error),
      );
      this.pools.set(taskModule, pool);
    }
    // The worker protocol erases types across the thread boundary; the cast
    // re-attaches the caller's declared output type.
    return pool.run(input, timeoutMs as number | undefined) as Promise<TOutput>;
  }

  /**
   * Returns a snapshot of every pool created so far.
   *
   * @returns One {@linkcode TaskPoolStats} per task module
   */
  stats(): readonly TaskPoolStats[] {
    return [...this.pools.values()].map((pool) => pool.stats());
  }

  /**
   * Shuts down every pool (terminating workers, rejecting pending tasks).
   * Safe to call more than once.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.budget.close();
    await Promise.all([...this.pools.values()].map((pool) => pool.shutdown()));
  }

  /** Merges plugin defaults with the per-task-module overrides (§4.1). */
  private resolveConfig(
    taskModule: string,
    host: IWorkerHost,
  ): {
    specifier: string;
    label: string;
    size: number;
    maxQueue: number;
    taskTimeoutMs: number;
    startupTimeoutMs: number;
  } {
    // Only the validated snapshot is consulted; see SizingSnapshot.
    const sizing = this.sizing;
    const overrides = sizing.pools.get(taskModule);
    return {
      specifier: taskModule,
      label: taskLabelOf(this, taskModule),
      size: overrides?.size ?? sizing.defaultPoolSize ?? host.availableParallelism(),
      maxQueue: overrides?.maxQueue ?? sizing.maxQueue ?? DEFAULT_MAX_QUEUE,
      taskTimeoutMs: overrides?.taskTimeoutMs ?? sizing.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      startupTimeoutMs: this.sizing.startupTimeoutMs,
    };
  }
}
