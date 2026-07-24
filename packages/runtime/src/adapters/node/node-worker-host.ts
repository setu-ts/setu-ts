/**
 * Node worker host — implements {@linkcode IWorkerHost} over
 * `node:worker_threads`.
 *
 * Uses static `node:` imports (supported by Deno, Node, and Bun) behind an
 * injectable {@linkcode NodeWorkerModules} seam so tests can exercise every
 * wrapper without spawning real threads.
 *
 * @module
 */

import type { IWorkerHandle, IWorkerHost } from '@hono-enterprise/common';
import { Worker as NodeThreadWorker } from 'node:worker_threads';
import { availableParallelism as osAvailableParallelism } from 'node:os';

/**
 * Minimal shape of a `node:worker_threads` `Worker` as used by this host.
 */
export interface NodeWorkerLike {
  /** Posts a structured-clonable message to the worker. */
  postMessage(value: unknown): void;
  /** Registers an event listener (`'message'` payloads arrive unwrapped). */
  on(event: 'message' | 'error', listener: (arg: unknown) => void): unknown;
  /** Terminates the worker; resolves with the exit code. */
  terminate(): Promise<number>;
}

/**
 * The Node built-ins this host needs. Inject fakes to test without real
 * threads.
 */
export interface NodeWorkerModules {
  /** The `worker_threads.Worker` constructor. */
  readonly Worker: new (specifier: string | URL) => NodeWorkerLike;
  /** `os.availableParallelism`. */
  readonly availableParallelism: () => number;
}

/** Default modules backed by the static `node:` imports. */
const defaultNodeWorkerModules: NodeWorkerModules = {
  Worker: NodeThreadWorker as unknown as new (specifier: string | URL) => NodeWorkerLike,
  availableParallelism: osAvailableParallelism,
};

/**
 * Creates an {@linkcode IWorkerHost} backed by `node:worker_threads`.
 *
 * `file:` specifiers are passed to the `Worker` constructor as `URL`
 * instances (Node rejects `file:` URLs given as strings); other specifiers
 * pass through as paths.
 *
 * @param mods - Injected Node modules (defaults to real `node:` built-ins)
 * @returns A worker host
 * @since 0.1.0
 */
export function createNodeWorkerHost(
  mods: NodeWorkerModules = defaultNodeWorkerModules,
): IWorkerHost {
  return {
    spawn(specifier: string): IWorkerHandle {
      const target = specifier.startsWith('file:') ? new URL(specifier) : specifier;
      const worker = new mods.Worker(target);
      return {
        postMessage: (message: unknown) => worker.postMessage(message),
        onMessage: (listener: (message: unknown) => void) => {
          worker.on('message', listener);
        },
        onError: (listener: (error: Error) => void) => {
          worker.on('error', (arg: unknown) => {
            listener(arg instanceof Error ? arg : new Error(String(arg)));
          });
        },
        terminate: () => worker.terminate().then(() => undefined),
      };
    },
    availableParallelism(): number {
      return mods.availableParallelism();
    },
  };
}
