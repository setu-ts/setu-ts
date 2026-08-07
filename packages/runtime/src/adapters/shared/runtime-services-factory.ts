/**
 * Builds {@linkcode IRuntimeServices} for the detected (or requested) platform.
 *
 * The platform → factory map lives here rather than inside `RuntimePlugin`
 * because runtime services are needed in two places: by the plugin at
 * `register()`, and by callers that must read the environment BEFORE any
 * application exists — loading configuration to decide which plugins to
 * compose, for instance. Both go through {@linkcode createRuntimeServices}, so
 * detection, lookup, and the unsupported-platform error exist exactly once.
 *
 * @module
 */

import type { IRuntimeServices, RuntimePlatform } from '@setu-ts/common';

import { detectRuntime } from '../../detector/runtime-detector.ts';
import { createDenoRuntimeServices } from '../deno/deno-runtime.ts';
import { createNodeRuntimeServices } from '../node/node-runtime.ts';
import { createBunRuntimeServices } from '../bun/bun-runtime.ts';
import { createCloudflareRuntimeServices } from '../workers/cf-runtime.ts';

/**
 * Map of platform → runtime adapter factory.
 *
 * Supplying one replaces the built-in map wholesale, which is how a unit test
 * builds services without the real runtime globals or OS permissions.
 *
 * @since 0.2.0
 */
export interface RuntimeAdapterFactories {
  /** Factory for Deno. */
  deno?: () => IRuntimeServices;
  /** Factory for Node.js. */
  node?: () => IRuntimeServices;
  /** Factory for Bun. */
  bun?: () => IRuntimeServices;
  /** Factory for Cloudflare Workers. */
  'cloudflare-workers'?: () => IRuntimeServices;
}

/**
 * Options for {@linkcode createRuntimeServices}.
 *
 * @since 0.2.0
 */
export interface CreateRuntimeServicesOptions {
  /**
   * Build services for this platform instead of auto-detecting.
   *
   * `RuntimePlugin` passes the platform it already resolved, so detection runs
   * once per application rather than once per caller.
   */
  readonly platform?: RuntimePlatform;
  /**
   * Replace the built-in platform → factory map.
   *
   * Supplying one also opts out of {@linkcode CreateRuntimeServicesOptions.env}:
   * the map is used verbatim, so a replacement factory owns its own env source.
   *
   * @internal
   */
  readonly adapters?: RuntimeAdapterFactories;
  /**
   * The Cloudflare Workers `env` record, which is the only way bindings and
   * variables reach a Worker — there is no ambient `process.env` on the edge.
   *
   * Pass the `env` the platform provides, typically
   * `import { env } from 'cloudflare:workers'`. Only its **string** entries
   * become {@linkcode IRuntimeServices.env}; object bindings (KV, R2, D1, …)
   * are reached through `CAPABILITIES.CLOUDFLARE` instead, because
   * `IRuntimeServices.env` is contracted as a string record.
   *
   * Ignored on Deno, Node, and Bun, which read their own ambient environment.
   *
   * @since 0.2.0
   */
  readonly env?: Readonly<Record<string, unknown>>;
}

/**
 * Builds the platform → factory map.
 *
 * A function rather than a module constant because the Cloudflare factory has
 * to close over the caller's `env`, and the three ambient-environment platforms
 * take unrelated first parameters that must not receive it.
 */
function defaultRuntimeAdapters(
  env: Readonly<Record<string, unknown>> | undefined,
): RuntimeAdapterFactories {
  return {
    deno: createDenoRuntimeServices,
    node: createNodeRuntimeServices,
    bun: createBunRuntimeServices,
    'cloudflare-workers': (): IRuntimeServices =>
      // `exactOptionalPropertyTypes`: omit `env` rather than pass undefined.
      createCloudflareRuntimeServices(env === undefined ? undefined : { env }),
  };
}

/**
 * Creates runtime services for the current platform.
 *
 * Use this when runtime services are needed before an application is
 * constructed — reading environment variables to build configuration, for
 * example. Inside an application, resolve `CAPABILITIES.RUNTIME` from the
 * service registry instead: `RuntimePlugin` registers the instance it builds
 * through this same function.
 *
 * The returned services are a stateless facade over platform globals, so
 * building a second instance alongside the application's own is safe: they hold
 * no connection, no cache, and no handle registry, and nothing compares them by
 * identity.
 *
 * One caveat worth knowing rather than discovering: `env` is a **snapshot taken
 * at construction**, not a live view. Two instances built at different moments
 * observe the environment as it was at each of those moments, so a variable set
 * in between is visible only to the later one.
 *
 * On Cloudflare Workers there is no ambient environment to snapshot, so `env`
 * stays empty unless {@linkcode CreateRuntimeServicesOptions.env} is supplied.
 *
 * @example Resolving configuration before choosing plugins
 * ```typescript
 * import { createRuntimeServices } from '@setu-ts/runtime';
 * import { loadConfig } from '@setu-ts/config-plugin';
 *
 * const config = await loadConfig(createRuntimeServices());
 * const url = config.getOrThrow<string>('DATABASE_URL');
 * ```
 * @example The same, on Cloudflare Workers
 * ```typescript
 * import { env } from 'cloudflare:workers';
 * import { createRuntimeServices } from '@setu-ts/runtime';
 *
 * const config = await loadConfig(createRuntimeServices({ env }));
 * ```
 * @param options - Platform override and adapter injection
 * @returns Runtime services for the resolved platform
 * @throws {Error} If no factory is registered for the resolved platform
 * @since 0.2.0
 */
export function createRuntimeServices(
  options?: CreateRuntimeServicesOptions,
): IRuntimeServices {
  const platform: RuntimePlatform = options?.platform ?? detectRuntime();
  const adapters = options?.adapters ?? defaultRuntimeAdapters(options?.env);

  const factory = (adapters as Record<string, (() => IRuntimeServices) | undefined>)[platform];
  if (factory === undefined) {
    throw new Error(`No runtime adapter factory for platform: ${platform}`);
  }
  return factory();
}
