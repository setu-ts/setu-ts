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
