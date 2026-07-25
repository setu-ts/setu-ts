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
} from '@hono-enterprise/common';
import type { WorkerPoolPluginOptions } from '../interfaces/index.ts';
import { WorkerPoolUnavailableError } from '../errors.ts';
import { TaskPool } from '../pool/task-pool.ts';

/** Default pending-queue bound per pool. */
const DEFAULT_MAX_QUEUE = 1024;
/** Default task timeout in milliseconds (`0` disables). */
const DEFAULT_TASK_TIMEOUT_MS = 30_000;

/**
 * The worker pool service registered under `CAPABILITIES.WORKER_POOL`.
 *
 * Resolves the worker host once: an injected `options.host` wins over the
 * runtime's `IRuntimeServices.workers`. When neither exists (e.g. Cloudflare
 * Workers), the service still constructs — `run()` throws
 * {@linkcode WorkerPoolUnavailableError}, `stats()` returns `[]`, and
 * `shutdown()` resolves — so one codebase stays deployable everywhere.
 *
 * @since 0.1.0
 */
export class WorkerPoolService implements IWorkerPool {
  private readonly host: IWorkerHost | undefined;
  private readonly pools = new Map<string, TaskPool>();

  constructor(
    private readonly options: WorkerPoolPluginOptions | undefined,
    private readonly runtime: IRuntimeServices,
  ) {
    this.host = options?.host ?? runtime.workers;
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
   */
  run<TInput, TOutput>(
    taskModule: string,
    input: TInput,
    options?: WorkerRunOptions,
  ): Promise<TOutput> {
    const host = this.host;
    if (host === undefined) {
      return Promise.reject(new WorkerPoolUnavailableError());
    }
    let pool = this.pools.get(taskModule);
    if (pool === undefined) {
      pool = new TaskPool(this.resolveConfig(taskModule, host), host, this.runtime);
      this.pools.set(taskModule, pool);
    }
    // The worker protocol erases types across the thread boundary; the cast
    // re-attaches the caller's declared output type.
    return pool.run(input, options?.timeoutMs) as Promise<TOutput>;
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
    await Promise.all([...this.pools.values()].map((pool) => pool.shutdown()));
  }

  /** Merges plugin defaults with the per-task-module overrides (§4.1). */
  private resolveConfig(taskModule: string, host: IWorkerHost): {
    specifier: string;
    size: number;
    maxQueue: number;
    taskTimeoutMs: number;
  } {
    const overrides = this.options?.pools?.[taskModule];
    return {
      specifier: taskModule,
      size: overrides?.size ?? this.options?.defaultPoolSize ?? host.availableParallelism(),
      maxQueue: overrides?.maxQueue ?? this.options?.maxQueue ?? DEFAULT_MAX_QUEUE,
      taskTimeoutMs: overrides?.taskTimeoutMs ?? this.options?.taskTimeoutMs ??
        DEFAULT_TASK_TIMEOUT_MS,
    };
  }
}
