/**
 * CQRS plugin options and interfaces.
 *
 * @module
 */
import type { IPipelineBehavior } from '@hono-enterprise/common';

/**
 * Options for {@linkcode CqrsPlugin}.
 *
 * @since 0.1.0
 */
export interface CqrsPluginOptions {
  /**
   * Pipeline behaviors applied to every command and query execution.
   *
   * Behaviors are invoked in declared order. Each behavior receives the
   * request and a `next()` function; returning without calling `next()`
   * short-circuits the pipeline (the handler and later behaviors do not run).
   *
   * Default: `[]` (no behaviors).
   */
  behaviors?: readonly IPipelineBehavior[];
}
