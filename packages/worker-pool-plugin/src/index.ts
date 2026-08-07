/**
 * @module
 *
 * WorkerPoolPlugin — run CPU-bound tasks on real worker threads behind the
 * `CAPABILITIES.WORKER_POOL` capability. Task modules register their handler
 * with `defineWorkerTask` from `@setu-ts/runtime/worker` and are
 * addressed by module specifier.
 *
 * Every export is documented in PUBLIC_API.md.
 */

export { WorkerPoolPlugin } from './plugin/worker-pool-plugin.ts';
export type { TaskPoolOptions, WorkerPoolPluginOptions } from './interfaces/index.ts';
export { WorkerPoolService } from './services/worker-pool-service.ts';
export {
  WorkerPoolUnavailableError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from './errors.ts';
