/**
 * Cloudflare Workers runtime adapter — provides {@linkcode IRuntimeServices}
 * using web-standard APIs available on Cloudflare Workers (crypto, performance,
 * global timers).
 *
 * `fs` is `undefined` (no file system on edge). `env` reads from an injectable
 * seam (defaulting to an empty record) because Workers bindings arrive via the
 * `env` parameter of the `fetch` handler, not a global — the application passes
 * them in, typically from `import { env } from 'cloudflare:workers'`.
 *
 * The supplied record is partitioned by {@linkcode splitWorkerEnv}: only its
 * string entries become `IRuntimeServices.env`, because that member is
 * contracted as a string record and `ConfigPlugin` iterates it. Object bindings
 * (KV, R2, D1, …) are reached through `CAPABILITIES.CLOUDFLARE` instead.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import { splitWorkerEnv } from '@setu-ts/common';

import { mergeRuntimeServices } from '../../services/cross-runtime.ts';

/**
 * Injectable environment seam for Cloudflare Workers bindings.
 * Defaults to an empty record so the adapter is testable without Workers globals.
 */
export interface CloudflareEnv {
  [key: string]: unknown;
}

/**
 * Options for {@linkcode createCloudflareRuntimeServices}.
 */
export interface CloudflareRuntimeOptions {
  /**
   * Injectable env source for reading Workers bindings.
   * Defaults to an empty record.
   */
  env?: CloudflareEnv;
  /**
   * The platform's `waitUntil`, from `import { waitUntil } from
   * 'cloudflare:workers'` (never one request's `ctx.waitUntil`). Exposed as
   * {@linkcode IRuntimeServices.waitUntil}; omitted, that member is absent.
   * @since 0.14.0
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Creates {@linkcode IRuntimeServices} for Cloudflare Workers.
 *
 * @param options - Optional configuration
 * @returns Complete runtime services for Cloudflare Workers
 */
export function createCloudflareRuntimeServices(
  options?: CloudflareRuntimeOptions,
): IRuntimeServices {
  const { vars } = splitWorkerEnv(options?.env ?? {});

  // `fs`, `workers`, `dns`, `createDnsResolver`, `onSignal` and `onFatalError`
  // are all deliberately ABSENT here: a Worker has no filesystem, no worker
  // threads and no socket DNS (so neither a resolver nor one with chosen name
  // servers), and the platform reports an uncaught error itself. For
  // `onSignal` specifically: a Worker isolate is evicted, never signalled, so
  // there is no signal to register for and no process to shut down
  // gracefully. Supplying a no-op instead would be worse than omitting it — a
  // caller checking `runtime.onSignal !== undefined` would conclude its
  // shutdown handler will run, and it never would.
  const waitUntil = options?.waitUntil;
  return mergeRuntimeServices({
    ...(waitUntil === undefined ? {} : { waitUntil: (promise) => waitUntil(promise) }),
    platform: () => 'cloudflare-workers',
    reportError: (record) => {
      try {
        // eslint-disable-next-line no-console -- runtime sink (M113f)
        console.error(JSON.stringify(record));
      } catch {
        // Last-resort reporting must never replace the request failure.
      }
    },
    version: () => '',
    hostname: () => '',
    env: vars,
    exit: () => {
      throw new Error('Process exit is not supported in Cloudflare Workers');
    },
  });
}
