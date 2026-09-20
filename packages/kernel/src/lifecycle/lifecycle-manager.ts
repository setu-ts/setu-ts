/**
 * Lifecycle manager — registers and executes lifecycle hooks in the correct
 * ordering. Shutdown hooks run in reverse (LIFO) for proper cleanup.
 *
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';
import type { ILifecycleApi } from '@setu-ts/common';

import { monotonicElapsed } from '../diagnostics/projection.ts';

type VoidHook = () => void | Promise<void>;
type RequestHook = (ctx: IRequestContext) => void | Promise<void>;
type ErrorHook = (error: Error, ctx: IRequestContext) => void | Promise<void>;

/**
 * The lifecycle phases the manager itself drains, named exactly as the
 * diagnostics stage vocabulary spells them. The request-scoped hooks
 * (`onRequest`/`onResponse`/`onError`) are invoked by the application and
 * observed there.
 *
 * @since 0.8.0
 */
export type LifecycleHookPhase =
  | 'register-hook'
  | 'init'
  | 'bootstrap'
  | 'stopping'
  | 'shutdown'
  | 'close';

/**
 * One hook invocation observed with its fixed phase plus execution ordinal —
 * ownership is NEVER inferred, because the manager does not record it.
 *
 * @since 0.8.0
 */
export interface LifecycleHookObservation {
  /** The lifecycle phase being drained. */
  readonly phase: LifecycleHookPhase;
  /** 1-based EXECUTION order within the phase (LIFO phases count downward). */
  readonly ordinal: number;
  /** Whether the hook threw (the error itself is never retained). */
  readonly failed: boolean;
  /** Monotonic start offset, or `null` when no runtime clock is available. */
  readonly startedAtMs: number | null;
  /** Inclusive monotonic elapsed ms, or `null`. */
  readonly durationMs: number | null;
}

/**
 * The diagnostics observer the application passes to instrument hook
 * execution. Observation never changes hook ordering, aggregation, or
 * propagation semantics.
 *
 * @since 0.8.0
 */
export interface LifecycleObserver {
  /** Monotonic clock; returns `null` when no runtime clock is available. */
  readonly clock: () => number | null;
  /** Called once per executed hook, in execution order. */
  readonly onHook: (observation: LifecycleHookObservation) => void;
}

/**
 * Default implementation of {@linkcode ILifecycleApi}. Stores hook arrays
 * and exposes execution methods for each lifecycle phase.
 */
export class LifecycleManager implements ILifecycleApi {
  readonly #register: VoidHook[] = [];
  /** Count of onRegister hooks already drained by {@linkcode runRegister}. */
  #registerCursor = 0;
  readonly #init: VoidHook[] = [];
  readonly #bootstrap: VoidHook[] = [];
  readonly #request: RequestHook[] = [];
  readonly #response: RequestHook[] = [];
  readonly #error: ErrorHook[] = [];
  readonly #stopping: VoidHook[] = [];
  readonly #shutdown: VoidHook[] = [];
  readonly #close: VoidHook[] = [];
  #observer: LifecycleObserver | undefined;

  /**
   * Installs the diagnostics observer for hook invocations. Pass `undefined`
   * to detach (teardown).
   *
   * @param observer - The observer, or `undefined`
   * @since 0.8.0
   */
  setLifecycleObserver(observer: LifecycleObserver | undefined): void {
    this.#observer = observer;
  }

  onRegister(fn: () => void | Promise<void>): void {
    this.#register.push(fn);
  }

  onInit(fn: () => void | Promise<void>): void {
    this.#init.push(fn);
  }

  onBootstrap(fn: () => void | Promise<void>): void {
    this.#bootstrap.push(fn);
  }

  onRequest(fn: (ctx: IRequestContext) => void | Promise<void>): void {
    this.#request.push(fn);
  }

  onResponse(fn: (ctx: IRequestContext) => void | Promise<void>): void {
    this.#response.push(fn);
  }

  onError(fn: (error: Error, ctx: IRequestContext) => void | Promise<void>): void {
    this.#error.push(fn);
  }

  onStopping(fn: () => void | Promise<void>): void {
    this.#stopping.push(fn);
  }

  onShutdown(fn: () => void | Promise<void>): void {
    this.#shutdown.push(fn);
  }

  onClose(fn: () => void | Promise<void>): void {
    this.#close.push(fn);
  }

  /**
   * Runs onRegister hooks added since the previous call, in registration
   * order. The kernel invokes this immediately after each plugin's
   * `register()` returns, so a plugin's onRegister hooks run "during the
   * owning plugin's registration" (per {@linkcode ILifecycleApi.onRegister})
   * — after that plugin and before the next one. A cursor tracks how many
   * hooks have already run so each plugin only fires the hooks it added; a
   * hook that registers a further onRegister hook drains it in the same pass.
   */
  async runRegister(): Promise<void> {
    while (this.#registerCursor < this.#register.length) {
      const fn = this.#register[this.#registerCursor]!;
      this.#registerCursor++;
      await this.#runObserved('register-hook', this.#registerCursor, fn);
    }
  }

  /** Runs all onInit hooks in registration order. */
  async runInit(): Promise<void> {
    let ordinal = 0;
    for (const fn of this.#init) {
      ordinal++;
      await this.#runObserved('init', ordinal, fn);
    }
  }

  /** Runs all onBootstrap hooks in registration order. */
  async runBootstrap(): Promise<void> {
    let ordinal = 0;
    for (const fn of this.#bootstrap) {
      ordinal++;
      await this.#runObserved('bootstrap', ordinal, fn);
    }
  }

  /**
   * Whether any onStopping hook is registered.
   *
   * `Application` checks this rather than awaiting unconditionally: awaiting
   * an already-resolved promise still defers the rest of `stop()` by a
   * microtask, which would move when `#stopping` flips and change the answer a
   * request arriving in that same tick gets. Branching keeps the new phase
   * genuinely zero-width for an application that registers no hook.
   */
  hasStopping(): boolean {
    return this.#stopping.length > 0;
  }

  /**
   * Runs stopping hooks in reverse registration order (LIFO), before the
   * application starts refusing requests.
   */
  async runStopping(): Promise<void> {
    for (let i = this.#stopping.length - 1; i >= 0; i--) {
      await this.#runObserved('stopping', this.#stopping.length - i, this.#stopping[i]!);
    }
  }

  /** Runs shutdown hooks in reverse registration order (LIFO cleanup). */
  async runShutdown(): Promise<void> {
    for (let i = this.#shutdown.length - 1; i >= 0; i--) {
      await this.#runObserved('shutdown', this.#shutdown.length - i, this.#shutdown[i]!);
    }
  }

  /**
   * Runs close hooks in registration order (after shutdown completes).
   *
   * EVERY hook runs, even when an earlier one rejects: a close hook releases
   * one plugin's resources, and letting the first failure abort the loop meant
   * one plugin that could not disconnect kept every later plugin from
   * releasing anything — the M50 `onStopping` defect in a second place. The
   * caller still learns about the failures, from an `AggregateError` raised
   * once the whole list has run; a single failure is rethrown as itself, so an
   * existing `instanceof` check on the hook's own error still matches.
   *
   * @throws {AggregateError} When more than one hook rejected
   */
  async runClose(): Promise<void> {
    const errors: unknown[] = [];
    let ordinal = 0;
    for (const fn of this.#close) {
      ordinal++;
      try {
        await this.#runObserved('close', ordinal, fn);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'One or more close hooks failed.');
    }
  }

  /**
   * Returns the request hooks list for the application to invoke during
   * request processing.
   */
  getRequestHooks(): readonly RequestHook[] {
    return this.#request;
  }

  /**
   * Returns the response hooks list for the application to invoke after
   * the response is produced.
   */
  getResponseHooks(): readonly RequestHook[] {
    return this.#response;
  }

  /**
   * Returns the error hooks list for the application to invoke when an
   * error escapes middleware or a handler.
   */
  getErrorHooks(): readonly ErrorHook[] {
    return this.#error;
  }

  /**
   * Runs one hook, observing its completion when an observer is installed.
   * With no observer this is a bare `await fn()` — zero added work. A
   * throwing hook is recorded as `failed` (never with the error itself) and
   * re-thrown with its identity intact, so ordering, aggregation, and
   * propagation semantics are unchanged.
   */
  async #runObserved(phase: LifecycleHookPhase, ordinal: number, fn: VoidHook): Promise<void> {
    const observer = this.#observer;
    if (observer === undefined) {
      await fn();
      return;
    }
    const startedAtMs = observer.clock();
    let failed = false;
    try {
      await fn();
    } catch (error) {
      failed = true;
      observer.onHook({
        phase,
        ordinal,
        failed,
        startedAtMs,
        durationMs: monotonicElapsed(observer.clock, startedAtMs),
      });
      throw error;
    }
    observer.onHook({
      phase,
      ordinal,
      failed,
      startedAtMs,
      durationMs: monotonicElapsed(observer.clock, startedAtMs),
    });
  }
}
