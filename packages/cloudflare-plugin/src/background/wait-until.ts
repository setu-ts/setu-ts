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

import type { ILogger } from '@setu-ts/common';

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
 * Resolves the logger at the moment a background task fails.
 *
 * A thunk rather than an `ILogger`, because the plugin context resolves
 * `logger` lazily: capturing its value during `register()` freezes whatever was
 * registered by then, and a logger registered imperatively afterwards would
 * never receive a report.
 *
 * @returns The logger, when one is resolvable
 * @since 0.2.0
 */
export type LoggerSource = () => ILogger | undefined;

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
 * @param logger - Resolves the logger at failure time, never at registration
 * @returns The `waitUntil` implementation to publish on the bindings service
 * @since 0.2.0
 */
export function resolveWaitUntil(
  host: WaitUntilHost | undefined,
  logger: LoggerSource,
): WaitUntilHost {
  return (promise: Promise<unknown>): void => {
    const reported = promise.catch((error: unknown) => {
      logger()?.error('cloudflare: background task failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    host?.(reported);
  };
}

/**
 * The registries built with no `waitUntil` host (M113d §3.6).
 *
 * `store()` in `cache-api-middleware.ts` hands the edge-cache write to
 * `bindings.waitUntil` only when the resolved bindings are NOT in this set;
 * a hostless registry's sink delegates to nothing, so handing the write to it
 * abandons the write when the isolate is released — the V9-23 mechanism.
 * A bindings object from a replacement provider (`override: true`) is never
 * in the set and is trusted to carry a sink: that is its contract, not ours.
 *
 * @internal - Module-private to the package that writes and reads it
 */
const hostlessRegistries = new WeakSet<object>();

/**
 * Records that `registry` was built with no `waitUntil` host.
 *
 * @param registry - The {@linkcode BindingRegistry} just registered
 * @internal
 */
export function markHostlessRegistry(registry: object): void {
  hostlessRegistries.add(registry);
}

/**
 * True when `registry` was built with no `waitUntil` host.
 *
 * @param registry - The bindings resolved from the capability registry
 * @internal
 */
export function isHostlessRegistry(registry: object): boolean {
  return hostlessRegistries.has(registry);
}
