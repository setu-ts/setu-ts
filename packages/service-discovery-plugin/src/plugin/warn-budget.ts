/**
 * A logger wrapper that caps how many `warn` lines the per-name resolve
 * reporters write together. Internal — not exported from the package barrel.
 *
 * Each failing name opens its own reporter, which warns once per failure run.
 * Names an application resolves are its own choice, but nothing stops one from
 * taking them from requests; distinct failing names would then write one
 * `warn` each without bound. Past the budget, a window's further `warn` lines
 * are written at `debug`, and one `warn` says that this is happening.
 *
 * @module
 */
import type { ConnectionErrorLogger } from '@setu-ts/common';

/** `warn` lines allowed per window across every resolve reporter. */
export const RESOLVE_WARN_BUDGET = 20;

/** The budget window, in milliseconds. */
export const RESOLVE_WARN_WINDOW_MS = 60_000;

/**
 * Wraps a logger so at most {@linkcode RESOLVE_WARN_BUDGET} `warn` lines are
 * written per {@linkcode RESOLVE_WARN_WINDOW_MS}; the rest go to `debug`.
 *
 * @param logger - Reads the current logger (absent until a logger registers)
 * @param now - A monotonic clock in milliseconds
 * @param source - Names the budget in its one notice line
 * @returns A logger getter for `createConnectionErrorReporter`
 */
export function createWarnBudget(
  logger: () => ConnectionErrorLogger | undefined,
  now: () => number,
  source: string,
): () => ConnectionErrorLogger | undefined {
  let windowStart = Number.NEGATIVE_INFINITY;
  let written = 0;
  let noticed = false;
  const budgeted: ConnectionErrorLogger = {
    warn(message, meta) {
      const sink = logger();
      if (sink === undefined) return;
      const at = now();
      if (!(at - windowStart < RESOLVE_WARN_WINDOW_MS)) {
        windowStart = at;
        written = 0;
        noticed = false;
      }
      if (written < RESOLVE_WARN_BUDGET) {
        written++;
        sink.warn(message, meta);
        return;
      }
      if (!noticed) {
        noticed = true;
        // Names the first line it moves to debug, so a real outage that lands
        // after the budget is still visible at warn level.
        sink.warn(
          `${source}: more than ${RESOLVE_WARN_BUDGET} resolve failures this minute; ` +
            `further ones log at debug, starting with: ${message}`,
          { source, budget: RESOLVE_WARN_BUDGET },
        );
      }
      sink.debug(message, meta);
    },
    info(message, meta) {
      logger()?.info(message, meta);
    },
    debug(message, meta) {
      logger()?.debug(message, meta);
    },
  };
  return () => (logger() === undefined ? undefined : budgeted);
}
