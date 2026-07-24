/**
 * TaskPool — one pool of worker threads for ONE task-module specifier.
 *
 * Internal to the plugin (not exported from the barrel): the
 * `WorkerPoolService` creates one lazily per specifier. Workers spawn on
 * demand up to `size`; pending tasks wait in a bounded FIFO queue; a task
 * dispatches only to a worker that has posted the protocol ready signal.
 *
 * @module
 */

import type {
  IRuntimeServices,
  IWorkerHandle,
  IWorkerHost,
  TaskPoolStats,
  TimerHandle,
  WorkerTaskRequest,
} from '@hono-enterprise/common';
import { isWorkerReadySignal, isWorkerTaskReply } from '@hono-enterprise/common';
import {
  WorkerPoolUnavailableError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from '../errors.ts';

/** Configuration resolved by the service before constructing a pool. */
export interface TaskPoolConfig {
  /** The task-module specifier this pool executes. */
  readonly specifier: string;
  /** Maximum workers in the pool. */
  readonly size: number;
  /** Pending-queue bound. */
  readonly maxQueue: number;
  /** Default task timeout in ms; `0` disables. */
  readonly taskTimeoutMs: number;
}

/** A task waiting for a worker. */
interface PendingTask {
  readonly input: unknown;
  readonly timeoutMs: number;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** A task currently executing on a worker. */
interface InFlightTask {
  readonly id: number;
  readonly timeoutMs: number;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  timer: TimerHandle | null;
}

/** One worker and its state. */
interface WorkerSlot {
  readonly handle: IWorkerHandle;
  ready: boolean;
  task: InFlightTask | null;
}

/**
 * A pool of workers executing one task module. See the module doc for the
 * lifecycle; error semantics follow the milestone plan §3.6–3.8:
 * handler errors keep the worker, crashes and timeouts drop (and for
 * timeouts terminate) it, and `shutdown()` rejects everything in flight.
 */
export class TaskPool {
  private readonly slots: WorkerSlot[] = [];
  private readonly pending: PendingTask[] = [];
  private nextTaskId = 0;
  private completedCount = 0;
  private failedCount = 0;
  private closed = false;

  constructor(
    private readonly config: TaskPoolConfig,
    private readonly host: IWorkerHost,
    private readonly runtime: IRuntimeServices,
  ) {}

  /**
   * Queues one task and resolves with its result.
   *
   * @param input - Structured-clonable task input
   * @param timeoutMs - Per-call timeout override; `undefined` uses the pool
   * default, `0` disables
   * @returns The task's output
   */
  run(input: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new WorkerPoolUnavailableError('Worker pool has been shut down'));
    }
    if (this.pending.length >= this.config.maxQueue) {
      return Promise.reject(
        new WorkerQueueFullError(this.config.specifier, this.config.maxQueue),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.push({
        input,
        timeoutMs: timeoutMs ?? this.config.taskTimeoutMs,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /** Returns a snapshot of this pool's state. */
  stats(): TaskPoolStats {
    return {
      taskModule: this.config.specifier,
      workers: this.slots.length,
      busy: this.slots.filter((slot) => slot.task !== null).length,
      queued: this.pending.length,
      completed: this.completedCount,
      failed: this.failedCount,
    };
  }

  /**
   * Terminates every worker and rejects in-flight and queued tasks with
   * `WorkerPoolUnavailableError`. Idempotent.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    const slots = this.slots.splice(0);
    for (const slot of slots) {
      if (slot.task !== null) {
        this.clearTaskTimer(slot.task);
        this.failedCount++;
        slot.task.reject(new WorkerPoolUnavailableError('Worker pool has been shut down'));
        slot.task = null;
      }
    }
    const queued = this.pending.splice(0);
    for (const task of queued) {
      this.failedCount++;
      task.reject(new WorkerPoolUnavailableError('Worker pool has been shut down'));
    }
    await Promise.all(slots.map((slot) => slot.handle.terminate()));
  }

  /** Dispatches pending tasks to idle workers, spawning up to `size`. */
  private pump(): void {
    if (this.closed) {
      return;
    }
    for (const slot of this.slots) {
      if (this.pending.length === 0) {
        return;
      }
      if (slot.ready && slot.task === null) {
        const item = this.pending.shift();
        if (item !== undefined) {
          this.dispatch(slot, item);
        }
      }
    }
    // Spawn at most one worker per waiting task not already covered by a
    // worker that is still starting up.
    const starting = this.slots.filter((slot) => !slot.ready).length;
    let deficit = Math.min(
      this.pending.length - starting,
      this.config.size - this.slots.length,
    );
    while (deficit > 0) {
      this.spawnSlot();
      deficit--;
    }
  }

  private spawnSlot(): void {
    const handle = this.host.spawn(this.config.specifier);
    const slot: WorkerSlot = { handle, ready: false, task: null };
    handle.onMessage((message) => this.onMessage(slot, message));
    handle.onError((error) => this.onWorkerError(slot, error));
    this.slots.push(slot);
  }

  private dispatch(slot: WorkerSlot, item: PendingTask): void {
    const id = ++this.nextTaskId;
    const task: InFlightTask = {
      id,
      timeoutMs: item.timeoutMs,
      resolve: item.resolve,
      reject: item.reject,
      timer: null,
    };
    slot.task = task;
    if (item.timeoutMs > 0) {
      task.timer = this.runtime.setTimeout(() => this.onTimeout(slot), item.timeoutMs);
    }
    const request: WorkerTaskRequest = {
      __hewp: 1,
      kind: 'task',
      id,
      input: item.input,
    };
    slot.handle.postMessage(request);
  }

  private onMessage(slot: WorkerSlot, message: unknown): void {
    if (isWorkerReadySignal(message)) {
      slot.ready = true;
      this.pump();
      return;
    }
    if (!isWorkerTaskReply(message)) {
      return;
    }
    const task = slot.task;
    if (task === null || message.id !== task.id) {
      return;
    }
    this.clearTaskTimer(task);
    slot.task = null;
    if (message.ok) {
      this.completedCount++;
      task.resolve(message.result);
    } else {
      this.failedCount++;
      task.reject(
        new WorkerTaskError(
          this.config.specifier,
          message.error ?? { name: 'Error', message: 'Unknown worker error' },
        ),
      );
    }
    this.pump();
  }

  /** A crashed worker fails its in-flight task and leaves the pool (§3.7). */
  private onWorkerError(slot: WorkerSlot, error: Error): void {
    this.dropSlot(slot);
    const task = slot.task;
    if (task !== null) {
      this.clearTaskTimer(task);
      slot.task = null;
      this.failedCount++;
      task.reject(
        new WorkerTaskError(this.config.specifier, {
          name: error.name,
          message: error.message,
          ...(error.stack !== undefined ? { stack: error.stack } : {}),
        }),
      );
    }
    this.pump();
  }

  /** A timed-out worker is terminated and replaced (§3.6). */
  private onTimeout(slot: WorkerSlot): void {
    const task = slot.task;
    if (task === null) {
      return;
    }
    task.timer = null;
    slot.task = null;
    this.dropSlot(slot);
    void slot.handle.terminate();
    this.failedCount++;
    task.reject(new WorkerTaskTimeoutError(this.config.specifier, task.timeoutMs));
    this.pump();
  }

  private clearTaskTimer(task: InFlightTask): void {
    if (task.timer !== null) {
      this.runtime.clearTimeout(task.timer);
      task.timer = null;
    }
  }

  private dropSlot(slot: WorkerSlot): void {
    const index = this.slots.indexOf(slot);
    if (index !== -1) {
      this.slots.splice(index, 1);
    }
  }
}
