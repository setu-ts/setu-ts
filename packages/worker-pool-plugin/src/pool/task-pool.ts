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
  WorkerExitError,
  WorkerPoolUnavailableError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from '../errors.ts';
import type { WorkerPoolCollector } from '../metrics/worker-pool-collector.ts';
import type { TaskFailureReason } from '../metrics/metric-names.ts';

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
  /**
   * Set before the pool asks this worker to stop, so its exit is recognized as
   * the answer to that request rather than as a crash. Bun emits its `'close'`
   * event after a host-requested `terminate()` too (measured), so an exit
   * handler that trusted every exit would act twice on one worker.
   *
   * Measured honestly: removing this flag changes NO observable behaviour
   * today, because `shutdown()` drains `pending` before it terminates anything
   * and `onTimeout` nulls the slot's task first — so the exit that follows
   * finds nothing left to settle. What it does is make that a LOCAL invariant
   * instead of one spread across two other methods: with the flag gone and
   * `shutdown()`'s drain moved after its `terminate()` calls (probed), two
   * queued tasks reject with `WorkerExitError` instead of the shutdown error,
   * because each not-yet-ready slot's exit takes the startup-failure branch.
   */
  terminating: boolean;
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
    /**
     * Present only when the application registered `CAPABILITIES.METRICS`.
     * Every call site is optional-chained, so an application without the
     * metrics plugin runs exactly the code M45 shipped.
     */
    private readonly collector?: WorkerPoolCollector,
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
      this.collector?.taskRejected(this.config.specifier, 'pool_closed');
      return Promise.reject(new WorkerPoolUnavailableError('Worker pool has been shut down'));
    }
    if (this.pending.length >= this.config.maxQueue) {
      // Counted as a REJECTION, not a failure: no `Task` exists yet, so this
      // never reaches `rejectTask` and `stats().failed` cannot see it either.
      this.collector?.taskRejected(this.config.specifier, 'queue_full');
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
      this.syncMetrics();
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
          'shutdown',
        );
        slot.task = null;
      }
    }
    const queued = this.pending.splice(0);
    for (const task of queued) {
      this.rejectTask(
        task,
        new WorkerPoolUnavailableError('Worker pool has been shut down'),
        'shutdown',
      );
    }
    this.syncMetrics();
    for (const slot of slots) {
      slot.terminating = true;
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
      // A dispatch that fails to hand the task over (a non-cloneable input)
      // settles that task and leaves the slot free, so the same slot takes the
      // next waiting task rather than the queue stalling behind one bad input.
      // The loop therefore ends either when the slot becomes busy or when the
      // queue runs dry — the `undefined` shift IS that second exit, not a
      // defensive arm.
      while (slot.ready && slot.task === null) {
        const item = this.pending.shift();
        if (item === undefined) {
          break;
        }
        this.dispatch(slot, item);
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
    const slot: WorkerSlot = { handle, ready: false, task: null, terminating: false };
    handle.onMessage((message) => this.onMessage(slot, message));
    handle.onError((error) => this.onWorkerError(slot, error));
    // Optional: absent on hosts whose runtime reports nothing when a thread
    // ends (Deno's web `Worker`). Where it IS present, a worker that stops
    // without erroring settles its task instead of leaving it pending until the
    // timeout — which `taskTimeoutMs: 0` disables entirely (X8-7).
    handle.onExit?.((code) => this.onWorkerExit(slot, code));
    this.slots.push(slot);
  }

  /**
   * Hands one task to one worker.
   *
   * `postMessage` throws synchronously when the input is not
   * structured-clonable (a function, a class instance with methods, a stream).
   * That throw MUST be caught here rather than at the call sites: reached from
   * `run()` it would reject the caller's promise, but reached from `pump()`
   * inside an `onMessage` callback it is an uncaught exception that kills the
   * host process (X8-2). Catching in one place makes both paths agree.
   *
   * The worker never received anything, so it stays in the pool and its slot
   * is freed for the next task — only the task is bad, not the pool.
   */
  private dispatch(slot: WorkerSlot, task: Task): void {
    task.id = ++this.nextTaskId;
    slot.task = task;
    const request: WorkerTaskRequest = {
      __hewp: 1,
      kind: 'task',
      id: task.id,
      input: task.input,
    };
    try {
      slot.handle.postMessage(request);
    } catch (error) {
      slot.task = null;
      this.rejectTask(
        task,
        error instanceof Error ? error : new Error(String(error)),
        'clone',
      );
    }
  }

  private onMessage(slot: WorkerSlot, message: unknown): void {
    if (isWorkerReadySignal(message)) {
      slot.ready = true;
      this.pump();
      this.syncMetrics();
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
        'handler',
      );
    }
    this.pump();
    this.syncMetrics();
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
      this.rejectTask(task, new WorkerTaskError(this.config.specifier, shape), 'crash');
    } else if (!slot.ready) {
      const waiting = this.pending.shift();
      if (waiting !== undefined) {
        this.rejectTask(waiting, new WorkerTaskError(this.config.specifier, shape), 'crash');
      }
    }
    this.pump();
    this.syncMetrics();
  }

  /**
   * The worker's thread ended. Disposition mirrors a crash — drop the slot,
   * fail whatever it was running, re-pump — because from the pool's side the
   * two are the same event: work was handed to a thread that no longer exists.
   *
   * An exit the pool ASKED for is ignored: `shutdown()` and `onTimeout` have
   * already settled that slot's task and removed it, so acting again would
   * either double-settle or, on a slot that never became ready, reject an
   * unrelated queued task.
   */
  private onWorkerExit(slot: WorkerSlot, code: number | null): void {
    // `dropSlot` returning false means another handler already disposed of this
    // slot, so its death is accounted for. That is the ordinary crash sequence,
    // not an edge case: Node emits `'error'` and THEN `'exit'` for a worker
    // that dies from an uncaught exception, and Bun's `'close'` follows its
    // error the same way. Without this, the startup-failure branch below ran
    // twice for one crash and rejected a queued task that had never been
    // dispatched anywhere.
    if (slot.terminating || !this.dropSlot(slot)) {
      return;
    }
    const task = slot.task;
    if (task !== null) {
      slot.task = null;
      this.rejectTask(task, new WorkerExitError(this.config.specifier, code), 'crash');
    } else if (!slot.ready) {
      // A worker that died before signalling ready cannot load its module, so
      // the oldest waiting task can never run — fail it rather than respawning
      // into the same failure forever (the `onWorkerError` rule).
      const waiting = this.pending.shift();
      if (waiting !== undefined) {
        this.rejectTask(waiting, new WorkerExitError(this.config.specifier, code), 'crash');
      }
    }
    this.pump();
    this.syncMetrics();
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
        slot.terminating = true;
        void slot.handle.terminate();
      }
    }
    this.rejectTask(
      task,
      new WorkerTaskTimeoutError(this.config.specifier, task.timeoutMs),
      'timeout',
    );
    this.pump();
    this.syncMetrics();
  }

  /**
   * Settles a task as fulfilled. Callers remove it from its location first.
   *
   * The caller's promise is settled BEFORE the metric is recorded, and never
   * after: observing the work must not be able to lose it. With the order
   * reversed, an instrument write that throws leaves `task.resolve` unreached,
   * so a task the worker completed successfully would hang its caller forever
   * while the pool counted it as done.
   */
  private resolveTask(task: Task, result: unknown): void {
    this.clearTaskTimer(task);
    this.completedCount++;
    task.resolve(result);
    this.collector?.taskCompleted(this.config.specifier);
  }

  /**
   * Settles a task as rejected. Callers remove it from its location first.
   *
   * `reason` is pushed to the failure counter here, at the one site that also
   * increments `failedCount`, so the counter summed over `reason` always
   * equals `stats().failed` for this pool.
   */
  private rejectTask(task: Task, error: Error, reason: TaskFailureReason): void {
    this.clearTaskTimer(task);
    this.failedCount++;
    task.reject(error);
    this.collector?.taskFailed(this.config.specifier, reason);
  }

  /**
   * Writes the pool-state gauges from the same snapshot `/health` reads, so
   * the two surfaces cannot disagree.
   *
   * Called from the five origins of state change — `run`, `onMessage`,
   * `onWorkerError`, `onTimeout` and `shutdown`. Every other mutation
   * (`pump`, `dispatch`, `spawnSlot`, `dropSlot`, the settle helpers) is
   * reached only from one of those, so no transition escapes.
   */
  private syncMetrics(): void {
    this.collector?.syncGauges(this.stats());
  }

  private clearTaskTimer(task: Task): void {
    if (task.timer !== null) {
      this.runtime.clearTimeout(task.timer);
      task.timer = null;
    }
  }

  /**
   * Removes a slot from the pool.
   *
   * @param slot - The slot to remove
   * @returns `true` when the pool still owned it, `false` when it had already
   * been dropped — which is how {@linkcode onWorkerExit} recognizes a death
   * another handler has already accounted for.
   */
  private dropSlot(slot: WorkerSlot): boolean {
    const index = this.slots.indexOf(slot);
    if (index === -1) {
      return false;
    }
    this.slots.splice(index, 1);
    return true;
  }
}
