/**
 * Pipeline behavior composition.
 *
 * INTERNAL: not exported from the barrel.
 *
 * @module
 */
import type { CqrsPipelineBehavior, CqrsRequest } from '@hono-enterprise/common';

/**
 * Composes a pipeline of behaviors wrapping a terminal handler.
 *
 * Behaviors are wrapped last-to-first so `behaviors[0]` runs first (declared
 * order = execution order). Each behavior may short-circuit by returning
 * without calling `next()`.
 *
 * @param request - The request being handled
 * @param behaviors - Behaviors to apply (in declared order)
 * @param terminal - The terminal handler
 * @returns The result of the pipeline
 * @since 0.1.0
 */
export function composePipeline(
  request: CqrsRequest,
  behaviors: readonly CqrsPipelineBehavior[],
  terminal: () => Promise<unknown>,
): Promise<unknown> {
  let next = terminal;
  for (let i = behaviors.length - 1; i >= 0; i--) {
    const behavior = behaviors[i];
    const prev = next;
    next = () => Promise.resolve(behavior.handle(request, prev));
  }
  return next();
}
