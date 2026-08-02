/**
 * The `waitUntil` seam — extending a Worker invocation past its response so
 * analytics, log shipping, and cache writes can finish.
 *
 * The host is **injected**, never imported: `cloudflare:workers` is not a
 * specifier Deno can resolve, so a static import would break `deno check` on
 * every other runtime, and a dynamic import through a non-literal specifier is
 * the fake-lazy-import smell this repository bans. The application already
 * imports `env` from that module, so importing `waitUntil` beside it costs one
 * word.
 *
 * @module
 */

import type { ILogger } from '@hono-enterprise/common';

/**
 * A sink that keeps a Worker alive until the promise settles.
 *
 * `import { waitUntil } from 'cloudflare:workers'` satisfies this directly.
 *
 * @param promise - Work that must finish after the response is returned
 * @since 0.2.0
 */
export type WaitUntilHost = (promise: Promise<unknown>) => void;

/**
 * Builds the one `waitUntil` implementation both configurations funnel through.
 *
 * A rejection handler is attached on **both** paths, not only the delegating
 * one: background work is precisely the work nobody is awaiting, so a rejection
 * would otherwise surface as an unhandled rejection with no context, or vanish.
 *
 * With no host — every runtime other than Cloudflare Workers — the promise is
 * left to run. There is no request-scoped lifetime to extend off the edge, so
 * "do not cut this off" is already the default; delegating to nothing and
 * awaiting nothing is the faithful behaviour, not a silent downgrade.
 *
 * @param host - The platform sink, when the application supplied one
 * @param logger - Resolved logger, used to report a background failure
 * @returns The `waitUntil` implementation to publish on the bindings service
 * @since 0.2.0
 */
export function resolveWaitUntil(
  host: WaitUntilHost | undefined,
  logger: ILogger | undefined,
): WaitUntilHost {
  return (promise: Promise<unknown>): void => {
    const reported = promise.catch((error: unknown) => {
      logger?.error('cloudflare: background task failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    host?.(reported);
  };
}
