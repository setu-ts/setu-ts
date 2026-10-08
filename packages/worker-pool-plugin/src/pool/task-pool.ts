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
import { isWorkerReadySignal, isWorkerTaskReply, withDeadline } from '@setu-ts/common';
import {
  WorkerExitError,
  WorkerPoolUnavailableError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from '../errors.ts';
import type { WorkerPoolCollector } from '../metrics/worker-pool-collector.ts';
import type { TaskFailureReason } from '../metrics/metric-names.ts';
import type { WorkerBudget } from './worker-budget.ts';

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
  /**
   * How long a spawned worker may take to signal ready before it is
   * terminated and its slot returned. Independent of `taskTimeoutMs`, so a
   * module that never starts cannot hold shared capacity when task timeouts
   * are disabled.
   */
  readonly startupTimeoutMs: number;
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
  /** Startup deadline armed at spawn; cleared on ready and on removal. */
  startupTimer: TimerHandle | null;
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
  private readonly terminations = new Set<Promise<void>>();
  private nextTaskId = 0;
  private completedCount = 0;
  private failedCount = 0;
  private closed = false;

  constructor(
    private readonly config: TaskPoolConfig,
    private readonly host: IWorkerHost,
    private readonly runtime: IRuntimeServices,
    private readonly budget: WorkerBudget,
    /**
     * Present only when the application registered `CAPABILITIES.METRICS`.
     * Every call site is optional-chained, so an application without the
     * metrics plugin runs exactly the code M45 shipped.
     */
    private readonly collector?: WorkerPoolCollector,
  ) {
    this.budget.register(this);
  }

  /** Includes starting slots: a module with a loading worker is not starved. */
  isStarved(): boolean {
    return this.pending.length > 0 && this.slots.length === 0;
  }

  /** Whether another slot could serve queued work under this pool's size. */
  needsWorker(): boolean {
    return !this.closed && this.slots.length < this.config.size &&
      this.pending.length > this.slots.filter((slot) => !slot.ready).length;
  }

  /** The budget invokes this only from a reserved promise continuation. */
  resume(): void {
    this.pump();
    this.syncMetrics();
  }

  /** Retires one ready idle slot; safe to call from another pool's pump. */
  retireIdle(): boolean {
    const slot = this.slots.find((slot) => slot.ready && slot.task === null);
    if (slot === undefined) return false;
    slot.terminating = true;
    // This pool may already be waiting for an extra worker. Removing its own
    // request before dropping prevents it becoming the first starved waiter
    // as a consequence of the hand-over itself.
    this.budget.cancel(this);
    this.dropSlot(slot);
    this.terminateSlot(slot);
    this.syncMetrics();
    return true;
  }

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
    this.budget.cancel(this);
    const slots = this.slots.splice(0);
    for (const slot of slots) {
      this.clearStartupTimer(slot);
      this.budget.release();
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
    for (const slot of slots) this.terminateSlot(slot);
    await Promise.all(this.terminations);
  }

  /** Dispatches pending tasks to idle workers, spawning up to `size`. */
  private pump(): void {
    if (this.closed) {
      return;
    }
    for (const slot of this.slots) {
      if (this.pending.length === 0) {
        break;
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
    while (this.needsWorker()) {
      if (!this.budget.tryAcquire(this)) break;
      try {
        this.spawnSlot();
      } catch (error) {
        const task = this.pending.shift()!;
        this.rejectTask(task, error instanceof Error ? error : new Error(String(error)), 'crash');
        this.budget.cancel(this);
        // Each failed attempt consumes a task, so retries are bounded by the
        // queue. Recheck demand rather than stranding the rest without a wake-up.
      }
    }
    if (!this.needsWorker()) this.budget.cancel(this);
    // Rule 1 covers every pump origin, including ready and clone failure.
    while (this.budget.hasWaiters() && this.retireIdle()) {
      // Each retirement reserves capacity for the next eligible waiter.
    }
  }

  private spawnSlot(): void {
    const handle = this.host.spawn(this.config.specifier);
    const slot: WorkerSlot = {
      handle,
      ready: false,
      task: null,
      terminating: false,
      startupTimer: null,
    };
    try {
      handle.onMessage((message) => this.onMessage(slot, message));
      handle.onError((error) => this.onWorkerError(slot, error));
      // Optional: absent on hosts whose runtime reports nothing when a thread
      // ends (Deno's web `Worker`). Where it IS present, a worker that stops
      // without erroring settles its task instead of leaving it pending until
      // the timeout — which `taskTimeoutMs: 0` disables entirely (X8-7).
      handle.onExit?.((code) => this.onWorkerExit(slot, code));
    } catch (error) {
      // A handle whose listeners could not be attached can never report ready,
      // an error or an exit, so nothing would ever release a slot charged for
      // it. It is never charged: terminate it and let pump() settle a task.
      slot.terminating = true;
      this.terminateSlot(slot);
      throw error;
    }
    this.budget.acquired(this);
    slot.startupTimer = this.runtime.setTimeout(
      () => this.onStartupTimeout(slot),
      this.config.startupTimeoutMs,
    );
    this.slots.push(slot);
  }

  /**
   * A worker did not signal ready within `startupTimeoutMs`. Treated like a
   * crash during startup: the slot is removed and terminated, and the oldest
   * waiting task fails, so a module that cannot start reports it instead of
   * holding a shared slot forever (with `taskTimeoutMs: 0` nothing else would).
   */
  private onStartupTimeout(slot: WorkerSlot): void {
    slot.startupTimer = null;
    if (slot.ready || slot.terminating || !this.dropSlot(slot)) return;
    slot.terminating = true;
    this.terminateSlot(slot);
    const waiting = this.pending.shift();
    if (waiting !== undefined) {
      this.rejectTask(
        waiting,
        new WorkerTaskError(this.config.specifier, {
          name: 'WorkerStartupTimeout',
          message: `Worker did not signal ready within ${this.config.startupTimeoutMs}ms`,
        }),
        'timeout',
      );
    }
    this.pump();
    this.syncMetrics();
  }

  private clearStartupTimer(slot: WorkerSlot): void {
    if (slot.startupTimer !== null) {
      this.runtime.clearTimeout(slot.startupTimer);
      slot.startupTimer = null;
    }
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
    if (slot.terminating || !this.slots.includes(slot)) return;
    if (isWorkerReadySignal(message)) {
      this.clearStartupTimer(slot);
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
    // Rule 2: a module with no slot gets a turn before this queue reuses it.
    if (this.pending.length > 0 && this.budget.hasStarvedWaiter()) {
      this.retireIdle();
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
    if (slot.terminating || !this.dropSlot(slot)) return;
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
      // Starting workers serve pending demand, not a dispatched task. Reclaim
      // excess startup capacity so a module that never signals ready cannot
      // retain the shared budget after its queued deadlines expire.
      const starting = this.slots.filter((slot) => !slot.ready);
      // Keep one starting worker per task still queued — unless another module
      // has queued work and no worker at all. Then yield one, so a module that
      // never becomes ready under steady demand cannot hold the shared budget
      // against it: each expiry hands the freed slot to the starved module.
      const keep = this.budget.hasStarvedWaiter()
        ? Math.min(this.pending.length, starting.length - 1)
        : this.pending.length;
      const reclaimed = starting.slice(Math.max(0, keep));
      // Give up this pool's own place in the waiter queue first, exactly as
      // retireIdle() does: a pool already queued for an extra worker would
      // otherwise be handed back the very slot it is yielding.
      if (reclaimed.length > 0) this.budget.cancel(this);
      for (const slot of reclaimed) {
        slot.terminating = true;
        this.dropSlot(slot);
        this.terminateSlot(slot);
      }
    } else {
      const slot = this.slots.find((candidate) => candidate.task === task);
      if (slot !== undefined) {
        slot.task = null;
        this.dropSlot(slot);
        slot.terminating = true;
        this.terminateSlot(slot);
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
   * Called from `run`, `onMessage`, `onWorkerError`, `onWorkerExit`,
   * `onTimeout`, `onStartupTimeout`, `shutdown`, budget `resume` and
   * `retireIdle`. Every other mutation
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

  /** Contains host failures and bounds cleanup waits, including retired slots. */
  private terminateSlot(slot: WorkerSlot): void {
    let call: Promise<void>;
    try {
      call = slot.handle.terminate();
    } catch {
      // Cleanup failure must not escape a runtime callback or fail new work.
      return;
    }
    const termination = withDeadline(() => call, {
      timeoutMs: 1_000,
      onTimeout: () => new Error('Worker termination did not settle within 1000ms'),
      timing: {
        setTimer: (fn, ms) => this.runtime.setTimeout(fn, ms),
        clearTimer: (handle) => this.runtime.clearTimeout(handle),
      },
    }).catch(() => undefined);
    this.terminations.add(termination);
    void termination.then(() => {
      this.terminations.delete(termination);
    });
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
    this.clearStartupTimer(slot);
    this.budget.release();
    return true;
  }
}
