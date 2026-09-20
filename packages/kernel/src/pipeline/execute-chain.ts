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
import type { DiagnosticsEventOutcome, IRequestContext, MiddlewareFunction } from '@setu-ts/common';

import type { ResponseBuilder } from '../context/response.ts';
import { monotonicElapsed } from '../diagnostics/projection.ts';

/**
 * One executed stage's completion record, reported in actual completion order.
 * Skipped stages (the defense-in-depth early returns) emit no record.
 *
 * @since 0.8.0
 */
export interface ChainStageObservation {
  /** 0-based index of the stage in the chain it was registered in. */
  readonly position: number;
  /** How the stage completed. */
  readonly outcome: Extract<
    DiagnosticsEventOutcome,
    'ok' | 'error' | 'short-circuit' | 'downstream-skipped'
  >;
  /** Monotonic start offset, or `null` when no runtime clock is available. */
  readonly startedAtMs: number | null;
  /** Inclusive monotonic elapsed ms (including downstream `next()` work). */
  readonly durationMs: number | null;
}

/**
 * The diagnostics observer the application passes to instrument a chain. The
 * clock is injected because observation must not read ambient time.
 *
 * @since 0.8.0
 */
export interface ChainObserver {
  /** Monotonic clock; returns `null` when no runtime clock is available. */
  readonly clock: () => number | null;
  /** Called once per EXECUTED stage, in completion order. */
  readonly onStage: (observation: ChainStageObservation) => void;
}

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
 * @param observer - Optional diagnostics observer. When absent the executor
 * performs no additional work beyond the original path; when present, each
 * stage's completion is observed inline without changing dispatch semantics —
 * a throw is recorded and re-thrown with its identity intact, and the
 * `downstream-skipped` outcome records a stage that called `next()` after the
 * response had already ended.
 * @throws {Error} If `next()` is called multiple times within a single middleware
 * @since 0.1.0
 */
export async function executeChain(
  chain: readonly MiddlewareFunction[],
  ctx: IRequestContext,
  terminal: () => Promise<void>,
  names?: readonly string[],
  observer?: ChainObserver,
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

  const elapsed = (startedAtMs: number | null): number | null =>
    observer === undefined ? null : monotonicElapsed(observer.clock, startedAtMs);

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
    const fn = chain[index]!;
    const position = index;
    index++;
    let nextCalled = false;
    let downstreamSkipped = false;
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
      if (observer !== undefined && responseEnded()) {
        // The stage called next() after ending the response; run()'s own
        // ended check below will skip the downstream. Recorded for the
        // caller's completion record — the outcome, not a new behavior.
        downstreamSkipped = true;
      }
      return run();
    };
    const startedAtMs = observer === undefined ? null : observer.clock();
    try {
      await fn(ctx, next);
    } catch (error) {
      if (observer !== undefined) {
        observer.onStage({
          position,
          outcome: 'error',
          startedAtMs,
          durationMs: elapsed(startedAtMs),
        });
      }
      throw error;
    }
    if (observer !== undefined) {
      observer.onStage({
        position,
        outcome: !nextCalled ? 'short-circuit' : downstreamSkipped ? 'downstream-skipped' : 'ok',
        startedAtMs,
        durationMs: elapsed(startedAtMs),
      });
    }
  };

  await run();
}
