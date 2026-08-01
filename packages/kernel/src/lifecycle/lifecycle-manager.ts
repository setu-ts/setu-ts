/**
 * Lifecycle manager — registers and executes lifecycle hooks in the correct
 * ordering. Shutdown hooks run in reverse (LIFO) for proper cleanup.
 *
 * @module
 */
import type { IRequestContext } from '@hono-enterprise/common';
import type { ILifecycleApi } from '@hono-enterprise/common';

type VoidHook = () => void | Promise<void>;
type RequestHook = (ctx: IRequestContext) => void | Promise<void>;
type ErrorHook = (error: Error, ctx: IRequestContext) => void | Promise<void>;

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
      const fn = this.#register[this.#registerCursor];
      this.#registerCursor++;
      await fn();
    }
  }

  /** Runs all onInit hooks in registration order. */
  async runInit(): Promise<void> {
    for (const fn of this.#init) {
      await fn();
    }
  }

  /** Runs all onBootstrap hooks in registration order. */
  async runBootstrap(): Promise<void> {
    for (const fn of this.#bootstrap) {
      await fn();
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
      await this.#stopping[i]();
    }
  }

  /** Runs shutdown hooks in reverse registration order (LIFO cleanup). */
  async runShutdown(): Promise<void> {
    for (let i = this.#shutdown.length - 1; i >= 0; i--) {
      await this.#shutdown[i]();
    }
  }

  /** Runs close hooks in registration order (after shutdown completes). */
  async runClose(): Promise<void> {
    for (const fn of this.#close) {
      await fn();
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
}
