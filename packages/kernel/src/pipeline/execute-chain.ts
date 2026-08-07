/**
 * Shared middleware-chain executor — classic next()-chaining with a
 * double-`next` guard and defense-in-depth against a stage that responds
 * AND calls `next()`.
 *
 * Both the global pipeline ({@linkcode MiddlewarePipeline}) and the
 * per-route middleware chain (dispatched from the application) delegate to
 * this helper so the chaining semantics are defined in exactly one place
 * (AI_GUIDELINES §11.1 — DRY).
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';

import type { ResponseBuilder } from '../context/response.ts';

/**
 * Executes a chain of middleware with classic `next()`-chaining semantics.
 *
 * Each middleware receives a `next` function that advances to the next
 * stage. A stage that returns without calling `next()` short-circuits the
 * chain — subsequent stages and the terminal are not invoked. As
 * defense-in-depth, before invoking the next stage (and before the
 * terminal) the executor also checks `ResponseBuilder.ended` on
 * `ctx.response`: if a stage has already produced a terminal response
 * (e.g. called `json()`), downstream stages are skipped even if that
 * stage incorrectly called `next()`.
 *
 * @param chain - The ordered middleware functions to execute
 * @param ctx - The request context (its `response` is a {@linkcode ResponseBuilder})
 * @param terminal - Called when every middleware has called `next()`
 * @param names - Optional diagnostic names, positionally matching `chain`, used
 * to identify the offending stage in the double-`next()` error. The global
 * pipeline supplies the names registered through `MiddlewareOptions.name`;
 * route-level chains have none and fall back to the function's own name.
 * @throws {Error} If `next()` is called multiple times within a single middleware
 * @since 0.1.0
 */
export async function executeChain(
  chain: readonly MiddlewareFunction[],
  ctx: IRequestContext,
  terminal: () => Promise<void>,
  names?: readonly string[],
): Promise<void> {
  let index = 0;

  // Defense in depth: stop once a prior stage has ended the response. The
  // check is guarded so callers passing a minimal context (e.g. the
  // pipeline unit tests with an empty object) don't crash on a missing
  // `response` — only a real ResponseBuilder exposes `ended`.
  const responseEnded = (): boolean => {
    const response = ctx.response as Partial<ResponseBuilder> | undefined;
    return typeof response?.ended === 'boolean' ? response.ended : false;
  };

  const run = async (): Promise<void> => {
    if (index >= chain.length) {
      // Defense in depth: do not run the terminal if a prior stage
      // already ended the response.
      if (responseEnded()) {
        return;
      }
      await terminal();
      return;
    }
    // Defense in depth: a prior stage ended the response — stop.
    if (responseEnded()) {
      return;
    }
    const fn = chain[index];
    const position = index;
    index++;
    let nextCalled = false;
    const next: () => Promise<void> = () => {
      if (nextCalled) {
        // Prefer the name registered via `MiddlewareOptions.name`, then the
        // function's own name. `fn.name` is ALWAYS a string — `''` for an
        // anonymous function — so `??` never fell back and the message read
        // "…in middleware " with a blank name. `||` is the correct operator.
        const label = names?.[position] || fn.name || '<anonymous>';
        throw new Error(
          `next() called multiple times in middleware ${label}`,
        );
      }
      nextCalled = true;
      return run();
    };
    await fn(ctx, next);
  };

  await run();
}
