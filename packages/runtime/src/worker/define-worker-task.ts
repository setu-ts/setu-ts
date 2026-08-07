/**
 * Worker-side task helper — the ONLY framework code that runs inside a worker
 * thread, published as the `@setu-ts/runtime/worker` subpath so task
 * modules can import it without pulling in the runtime plugin barrel.
 *
 * Application task modules call {@linkcode defineWorkerTask} at module top
 * level; the WorkerPoolPlugin's pool spawns workers of that module and speaks
 * the shared protocol from `@setu-ts/common` to them.
 *
 * @module
 */

import { resolveTaskPort, wireWorkerTask } from './task-port.ts';

/**
 * Registers this module's task handler. Call once, at module top level, in a
 * module that the WorkerPoolPlugin executes:
 *
 * @example
 * ```typescript
 * // tasks/resize-image.ts — runs on a worker thread
 * import { defineWorkerTask } from '@setu-ts/runtime/worker';
 *
 * defineWorkerTask<Uint8Array, Uint8Array>(async (imageBytes) => {
 *   return await resize(imageBytes);
 * });
 * ```
 *
 * Inputs and outputs travel by structured clone: plain data only, no
 * functions or class instances.
 *
 * @param fn - The task handler; may be async
 * @throws {Error} When called outside a worker
 * @since 0.1.0
 */
export function defineWorkerTask<TInput, TOutput>(
  fn: (input: TInput) => TOutput | Promise<TOutput>,
): void {
  wireWorkerTask(fn, resolveTaskPort());
}
