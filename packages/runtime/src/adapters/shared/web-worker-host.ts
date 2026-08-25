/**
 * Web worker host — implements {@linkcode IWorkerHost} over the web-standard
 * `Worker` API shared by Deno and Bun.
 *
 * Uses dependency injection: a {@linkcode WebWorkerGlobals} seam exposes the
 * `Worker` constructor and the reported hardware concurrency, defaulting to
 * the real globals via a single boundary cast. This allows unit testing on
 * any runtime by passing fakes.
 *
 * @module
 */

import type { IWorkerHandle, IWorkerHost } from '@setu-ts/common';

/**
 * Minimal shape of a web `Worker` instance as used by this host.
 */
export interface WebWorkerLike {
  /** Posts a structured-clonable message to the worker. */
  postMessage(message: unknown): void;
  /** Message handler slot; events carry the payload in `data`. */
  onmessage: ((event: { data: unknown }) => void) | null;
  /** Error handler slot; events carry a `message` when available. */
  onerror: ((event: unknown) => void) | null;
  /**
   * Registers an event listener. Only used for the runtime-specific
   * worker-ended event named by {@linkcode WebWorkerHostOptions.exitEventName},
   * which is not part of the web `Worker` standard and therefore has no
   * handler slot.
   */
  addEventListener(type: string, listener: (event: unknown) => void): void;
  /** Terminates the worker. */
  terminate(): void;
}

/**
 * Host-construction options that vary between the runtimes sharing this
 * implementation.
 *
 * @since 0.3.0
 */
export interface WebWorkerHostOptions {
  /**
   * Name of the non-standard event this runtime emits when a worker's thread
   * ends. Bun emits `'close'`; **Deno emits nothing at all**, so it passes
   * nothing and the handles this host produces omit `onExit` entirely.
   *
   * Omitted rather than registered-and-silent on purpose: a present `onExit`
   * that can never fire would let a consumer conclude it has worker-death
   * detection while a dead worker still went unnoticed.
   */
  readonly exitEventName?: string;
}

/**
 * The web globals this host needs. Inject fakes to test without spawning
 * real workers.
 */
export interface WebWorkerGlobals {
  /** The `Worker` constructor; absent on runtimes without web workers. */
  readonly Worker?: new (specifier: string, options: { type: 'module' }) => WebWorkerLike;
  /** Reported hardware concurrency (`navigator.hardwareConcurrency`). */
  readonly hardwareConcurrency?: number;
}

/** Shape of the global scope {@linkcode readWebWorkerGlobals} probes. */
export interface WebGlobalScope {
  Worker?: new (specifier: string, options: { type: 'module' }) => WebWorkerLike;
  navigator?: { hardwareConcurrency?: number };
}

/**
 * Reads the web worker globals off a scope, omitting absent members
 * (`exactOptionalPropertyTypes`). Internal seam, injectable for tests;
 * defaults to the real `globalThis` at host-creation time.
 *
 * @param scope - The global scope to probe
 * @returns The available web worker globals
 */
export function readWebWorkerGlobals(
  scope: WebGlobalScope = globalThis as WebGlobalScope,
): WebWorkerGlobals {
  const concurrency = scope.navigator?.hardwareConcurrency;
  return {
    ...(scope.Worker !== undefined ? { Worker: scope.Worker } : {}),
    ...(concurrency !== undefined ? { hardwareConcurrency: concurrency } : {}),
  };
}

/**
 * Normalizes a web `error` event (an `ErrorEvent`-like object or anything
 * else) to an `Error`.
 */
function normalizeErrorEvent(event: unknown): Error {
  if (event instanceof Error) {
    return event;
  }
  const message = (event as { message?: unknown })?.message;
  return new Error(typeof message === 'string' ? message : 'Worker error');
}

/**
 * Creates an {@linkcode IWorkerHost} backed by the web-standard `Worker` API
 * (Deno and Bun).
 *
 * @param globals - Injected web globals (defaults to the real `globalThis`)
 * @param options - Per-runtime differences; see
 * {@linkcode WebWorkerHostOptions.exitEventName}
 * @returns A worker host; its `spawn` throws when the runtime has no `Worker`
 * constructor
 * @since 0.1.0
 */
export function createWebWorkerHost(
  globals: WebWorkerGlobals = readWebWorkerGlobals(),
  options: WebWorkerHostOptions = {},
): IWorkerHost {
  const exitEventName = options.exitEventName;
  return {
    spawn(specifier: string): IWorkerHandle {
      const WorkerCtor = globals.Worker;
      if (WorkerCtor === undefined) {
        throw new Error('Web Worker API is not available on this runtime');
      }
      const worker = new WorkerCtor(specifier, { type: 'module' });
      return {
        postMessage: (message: unknown) => worker.postMessage(message),
        onMessage: (listener: (message: unknown) => void) => {
          worker.onmessage = (event) => listener(event.data);
        },
        onError: (listener: (error: Error) => void) => {
          worker.onerror = (event) => listener(normalizeErrorEvent(event));
        },
        // Present only when this runtime names an event that actually fires
        // (`exactOptionalPropertyTypes` — the key is omitted, not undefined).
        ...(exitEventName === undefined ? {} : {
          onExit: (listener: (code: number | null) => void) => {
            worker.addEventListener(exitEventName, (event: unknown) => {
              const code = (event as { code?: unknown } | null)?.code;
              listener(typeof code === 'number' ? code : null);
            });
          },
        }),
        terminate: () => {
          worker.terminate();
          return Promise.resolve();
        },
      };
    },
    availableParallelism(): number {
      return globals.hardwareConcurrency ?? 1;
    },
    reportsExit(): boolean {
      return exitEventName !== undefined;
    },
  };
}
