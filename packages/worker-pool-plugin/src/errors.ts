/**
 * Worker pool error classes exported for consumer `instanceof` handling.
 *
 * @module
 */

import type { WorkerErrorShape } from '@setu-ts/common';

/**
 * Thrown by `run()` when the runtime provides no worker support (no
 * `IRuntimeServices.workers` and no injected host) — e.g. Cloudflare Workers.
 *
 * @since 0.1.0
 */
export class WorkerPoolUnavailableError extends Error {
  constructor(message = 'Worker threads are not available on this runtime') {
    super(message);
    this.name = 'WorkerPoolUnavailableError';
  }
}

/**
 * Thrown by `run()` when the task handler threw on the worker, or when the
 * worker crashed while the task was in flight. Carries the remote error's
 * serialized shape.
 *
 * @since 0.1.0
 */
export class WorkerTaskError extends Error {
  /** The task-module specifier the failing task belonged to. */
  readonly taskModule: string;
  /** The remote error's `name`. */
  readonly remoteName: string;
  /** The remote error's `stack`, when the worker provided one. */
  readonly remoteStack?: string;

  constructor(taskModule: string, remote: WorkerErrorShape) {
    super(`Worker task failed (${taskModule}): ${remote.name}: ${remote.message}`);
    this.name = 'WorkerTaskError';
    this.taskModule = taskModule;
    this.remoteName = remote.name;
    if (remote.stack !== undefined) {
      this.remoteStack = remote.stack;
    }
  }
}

/**
 * Thrown by `run()` when a task exceeds its timeout. The worker running the
 * task is terminated and replaced — in-flight JavaScript cannot be cancelled.
 *
 * @since 0.1.0
 */
export class WorkerTaskTimeoutError extends Error {
  /** The task-module specifier the timed-out task belonged to. */
  readonly taskModule: string;
  /** The timeout that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(taskModule: string, timeoutMs: number) {
    super(`Worker task timed out after ${timeoutMs}ms (${taskModule})`);
    this.name = 'WorkerTaskTimeoutError';
    this.taskModule = taskModule;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by `run()` when the pool's pending queue is at its bound, shedding
 * the task instead of growing memory without limit.
 *
 * @since 0.1.0
 */
export class WorkerQueueFullError extends Error {
  /** The task-module specifier whose pool queue is full. */
  readonly taskModule: string;
  /** The configured queue bound. */
  readonly limit: number;

  constructor(taskModule: string, limit: number) {
    super(`Worker pool queue is full (${limit} pending) for ${taskModule}`);
    this.name = 'WorkerQueueFullError';
    this.taskModule = taskModule;
    this.limit = limit;
  }
}

/**
 * Thrown into a task's promise when its worker's THREAD ENDED while the task
 * was in flight — a clean self-termination (`process.exit()` inside the worker,
 * or `self.close()` on runtimes that report it) as much as an abrupt one.
 *
 * Distinct from {@linkcode WorkerTaskError}, which carries an error the worker
 * managed to report: a thread that simply stops raises nothing, so before the
 * pool observed exits the only thing that ever settled such a task was the task
 * timeout — and `taskTimeoutMs: 0` disabled it, leaving the caller's promise
 * pending and the pool slot claimed forever (X8-7).
 *
 * Only raised on runtimes whose worker host reports an exit; where it does not
 * (see `IWorkerHost.reportsExit`), the timeout remains the only backstop.
 *
 * @since 0.3.0
 */
export class WorkerExitError extends Error {
  /** The task-module specifier the abandoned task belonged to. */
  readonly taskModule: string;
  /** The exit code the runtime reported, or `null` when it reported none. */
  readonly code: number | null;

  constructor(taskModule: string, code: number | null) {
    super(
      `Worker thread for ${taskModule} exited while its task was in flight ` +
        `(code ${code === null ? 'unknown' : code})`,
    );
    this.name = 'WorkerExitError';
    this.taskModule = taskModule;
    this.code = code;
  }
}
