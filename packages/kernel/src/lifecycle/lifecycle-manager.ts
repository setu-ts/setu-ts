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
  readonly #init: VoidHook[] = [];
  readonly #bootstrap: VoidHook[] = [];
  readonly #request: RequestHook[] = [];
  readonly #response: RequestHook[] = [];
  readonly #error: ErrorHook[] = [];
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

  onShutdown(fn: () => void | Promise<void>): void {
    this.#shutdown.push(fn);
  }

  onClose(fn: () => void | Promise<void>): void {
    this.#close.push(fn);
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
