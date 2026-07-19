/**
 * Cloudflare Workers runtime adapter — provides {@linkcode IRuntimeServices}
 * using web-standard APIs available on Cloudflare Workers (crypto, performance,
 * global timers).
 *
 * `fs` is `undefined` (no file system on edge). `env` reads from an injectable
 * seam (defaulting to an empty record) because Workers bindings arrive via the
 * `env` parameter of the `fetch` handler, not a global.
 *
 * @module
 */

import type { IRuntimeServices } from '@hono-enterprise/common';
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
  const envSource = options?.env ?? {};

  return mergeRuntimeServices({
    platform: () => 'cloudflare-workers',
    version: () => '',
    hostname: () => '',
    // Cloudflare env bindings are often objects (KV/D1/R2), so we keep envSource
    // typed as Record<string, unknown> and cast only at this boundary.
    env: envSource as Readonly<Record<string, string | undefined>>,
    exit: () => {
      throw new Error('Process exit is not supported in Cloudflare Workers');
    },
  });
}
