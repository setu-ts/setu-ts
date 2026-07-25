/**
 * Public option types for the WorkerPoolPlugin.
 *
 * @module
 */

import type { IWorkerHost } from '@hono-enterprise/common';

/**
 * Per-task-module pool overrides, keyed by task-module specifier in
 * {@linkcode WorkerPoolPluginOptions.pools}.
 *
 * @since 0.1.0
 */
export interface TaskPoolOptions {
  /** Workers in this pool; overrides `defaultPoolSize`. */
  readonly size?: number;
  /** Pending-queue bound for this pool; overrides the plugin `maxQueue`. */
  readonly maxQueue?: number;
  /**
   * Task timeout in milliseconds for this pool; overrides the plugin
   * `taskTimeoutMs`. `0` disables the timeout.
   */
  readonly taskTimeoutMs?: number;
}

/**
 * Options for {@linkcode WorkerPoolPlugin}.
 *
 * @since 0.1.0
 */
export interface WorkerPoolPluginOptions {
  /**
   * Default workers per pool. Defaults to the host's
   * `availableParallelism()`.
   */
  readonly defaultPoolSize?: number;
  /** Default pending-queue bound per pool. Defaults to 1024. */
  readonly maxQueue?: number;
  /**
   * Default task timeout in milliseconds. Defaults to 30 000; `0` disables.
   * A worker whose task times out is terminated and replaced.
   */
  readonly taskTimeoutMs?: number;
  /** Per-task-module overrides, keyed by the specifier passed to `run()`. */
  readonly pools?: Readonly<Record<string, TaskPoolOptions>>;
  /**
   * Injected worker host, taking precedence over the runtime's
   * `IRuntimeServices.workers`. Intended for tests and custom transports.
   */
  readonly host?: IWorkerHost;
}
