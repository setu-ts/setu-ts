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
  WorkerErrorShape,
  WorkerTaskRequest,
} from '@setu-ts/common';
import { isWorkerReadySignal, isWorkerTaskReply } from '@setu-ts/common';
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

/**
 * A task tracked from enqueue to settlement. The same object flows from the
 * pending queue onto a worker slot; its timeout timer is armed at ENQUEUE (so
 * a task that never reaches a worker — e.g. a module that never signals ready
 * — still times out instead of hanging) and carried through dispatch.
 *
 * Single settlement is structural, not flag-guarded: every settle path both
 * removes the task from its pending/slot location AND clears its timer, so no
 * second settle (a duplicate reply, a post-settle timeout, a crash after
 * completion) can reach it.
 */
interface Task {
  readonly input: unknown;
  readonly timeoutMs: number;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  /** Correlation id; `0` while still pending, assigned at dispatch. */
  id: number;
  /** Timeout handle armed at enqueue; `null` when the timeout is disabled or cleared. */
  timer: TimerHandle | null;
}

/** One worker and its state. */
interface WorkerSlot {
  readonly handle: IWorkerHandle;
  ready: boolean;
  task: Task | null;
}

/**
 * A pool of workers executing one task module. See the module doc for the
 * lifecycle; error semantics follow the milestone plan §3.6–3.8: handler
 * errors keep the worker; a crash while running drops the worker; a crash
 * DURING startup (never became ready) fails the oldest waiting task so a load
 * failure surfaces immediately instead of respawning forever; timeouts drop
 * and terminate the worker; and `shutdown()` rejects everything in flight.
 */
export class TaskPool {
  private readonly slots: WorkerSlot[] = [];
  private readonly pending: Task[] = [];
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
   * default, `0` disables. The timeout is measured from ENQUEUE, so it also
   * bounds time spent waiting for a free/ready worker.
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
      const task: Task = {
        input,
        timeoutMs: timeoutMs ?? this.config.taskTimeoutMs,
        resolve,
        reject,
        id: 0,
        timer: null,
      };
      if (task.timeoutMs > 0) {
        task.timer = this.runtime.setTimeout(() => this.onTimeout(task), task.timeoutMs);
      }
      this.pending.push(task);
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
        this.rejectTask(
          slot.task,
          new WorkerPoolUnavailableError('Worker pool has been shut down'),
        );
        slot.task = null;
      }
    }
    const queued = this.pending.splice(0);
    for (const task of queued) {
      this.rejectTask(task, new WorkerPoolUnavailableError('Worker pool has been shut down'));
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

  private dispatch(slot: WorkerSlot, task: Task): void {
    task.id = ++this.nextTaskId;
    slot.task = task;
    const request: WorkerTaskRequest = {
      __hewp: 1,
      kind: 'task',
      id: task.id,
      input: task.input,
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
    slot.task = null;
    if (message.ok) {
      this.resolveTask(task, message.result);
    } else {
      this.rejectTask(
        task,
        new WorkerTaskError(
          this.config.specifier,
          message.error ?? { name: 'Error', message: 'Unknown worker error' },
        ),
      );
    }
    this.pump();
  }

  /**
   * A crashed worker leaves the pool (§3.7). A crash WHILE RUNNING fails its
   * in-flight task; a crash DURING startup (never became ready, no task yet)
   * fails the oldest waiting task so a module that cannot load surfaces its
   * error immediately instead of triggering an unbounded respawn loop.
   */
  private onWorkerError(slot: WorkerSlot, error: Error): void {
    this.dropSlot(slot);
    const shape: WorkerErrorShape = {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
    if (slot.task !== null) {
      const task = slot.task;
      slot.task = null;
      this.rejectTask(task, new WorkerTaskError(this.config.specifier, shape));
    } else if (!slot.ready) {
      const waiting = this.pending.shift();
      if (waiting !== undefined) {
        this.rejectTask(waiting, new WorkerTaskError(this.config.specifier, shape));
      }
    }
    this.pump();
  }

  /**
   * The task timeout fired. A task still queued is removed from the pending
   * queue; a task in flight has its worker terminated and replaced (§3.6).
   */
  private onTimeout(task: Task): void {
    // Reaching here means the timer was never cleared, so the task is unsettled
    // (every settle path clears the timer). No settled-flag guard is needed.
    task.timer = null;
    const pendingIndex = this.pending.indexOf(task);
    if (pendingIndex !== -1) {
      this.pending.splice(pendingIndex, 1);
    } else {
      const slot = this.slots.find((candidate) => candidate.task === task);
      if (slot !== undefined) {
        slot.task = null;
        this.dropSlot(slot);
        void slot.handle.terminate();
      }
    }
    this.rejectTask(task, new WorkerTaskTimeoutError(this.config.specifier, task.timeoutMs));
    this.pump();
  }

  /** Settles a task as fulfilled. Callers remove it from its location first. */
  private resolveTask(task: Task, result: unknown): void {
    this.clearTaskTimer(task);
    this.completedCount++;
    task.resolve(result);
  }

  /** Settles a task as rejected. Callers remove it from its location first. */
  private rejectTask(task: Task, error: Error): void {
    this.clearTaskTimer(task);
    this.failedCount++;
    task.reject(error);
  }

  private clearTaskTimer(task: Task): void {
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
