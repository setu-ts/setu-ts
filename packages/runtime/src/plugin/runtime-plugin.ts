/**
 * RuntimePlugin — registers {@linkcode IRuntimeServices} under
 * `CAPABILITIES.RUNTIME` and {@linkcode IHttpAdapter} under
 * `CAPABILITIES.HTTP_ADAPTER` so every other plugin can rely on runtime-agnostic
 * services and HTTP server capabilities.
 *
 * @module
 */

import type {
  IHttpAdapter,
  IPlugin,
  IPluginContext,
  RuntimePlatform,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { detectRuntime } from '../detector/runtime-detector.ts';
import type { RuntimeAdapterFactories } from '../adapters/shared/runtime-services-factory.ts';
import { createRuntimeServices } from '../adapters/shared/runtime-services-factory.ts';
import { DenoHttpAdapter } from '../adapters/deno/deno-http-adapter.ts';
import { NodeHttpAdapter } from '../adapters/node/node-http-adapter.ts';
import { BunHttpAdapter } from '../adapters/bun/bun-http-adapter.ts';
import { CloudflareWorkersHttpAdapter } from '../adapters/workers/cf-http-adapter.ts';

/**
 * Options for {@linkcode RuntimePlugin}.
 */
export interface RuntimeOptions {
  /**
   * Force a specific platform instead of auto-detecting.
   * Useful for testing or when running in an environment where detection
   * might be ambiguous.
   */
  platform?: RuntimePlatform;
  /**
   * Override runtime adapter factories for testing. When provided, the plugin
   * uses these instead of the real adapter factories, allowing unit tests to
   * run without OS permissions or real runtime globals.
   *
   * @internal
   */
  adapters?: RuntimeAdapterFactories;
  /**
   * Override HTTP adapter factories for testing. When provided, the plugin
   * uses these instead of the default HTTP adapters, allowing unit tests to
   * inject fake HTTP adapters.
   *
   * @internal
   */
  httpAdapters?: HttpAdapterFactories;
}

/**
 * Map of platform → HTTP adapter factory. Used internally for dependency injection.
 */
export interface HttpAdapterFactories {
  deno?: () => IHttpAdapter;
  node?: () => IHttpAdapter;
  bun?: () => IHttpAdapter;
  'cloudflare-workers'?: () => IHttpAdapter;
}

const defaultHttpAdapters: HttpAdapterFactories = {
  deno: () => new DenoHttpAdapter(),
  node: () => new NodeHttpAdapter(),
  bun: () => new BunHttpAdapter(),
  'cloudflare-workers': () => new CloudflareWorkersHttpAdapter(),
};

/**
 * Creates the RuntimePlugin that provides runtime-agnostic services and HTTP adapter.
 *
 * This plugin must be registered in every application. It has the highest
 * priority so its services are available to all other plugins during
 * registration.
 *
 * @param options - Optional configuration
 * @returns The runtime plugin
 * @throws {Error} If no HTTP adapter is available for the platform
 */
export function RuntimePlugin(options?: RuntimeOptions): IPlugin {
  const platform: RuntimePlatform = options?.platform ?? detectRuntime();
  const runtimeAdapters = options?.adapters;
  const httpAdapters = options?.httpAdapters ?? defaultHttpAdapters;

  return {
    name: 'runtime',
    version: '0.1.0',
    provides: [CAPABILITIES.RUNTIME, CAPABILITIES.HTTP_ADAPTER],
    priority: PLUGIN_PRIORITY.HIGHEST,

    register(ctx: IPluginContext): void {
      // Register runtime services. Built through the shared factory rather than
      // a second copy of the platform → adapter map, so a caller that needs
      // services before start() (config resolution) gets the same resolution
      // this plugin does.
      const services = createRuntimeServices(
        // `exactOptionalPropertyTypes`: omit `adapters` entirely rather than
        // passing undefined, so the factory's own default map applies.
        runtimeAdapters === undefined ? { platform } : { platform, adapters: runtimeAdapters },
      );
      ctx.services.register(CAPABILITIES.RUNTIME, services);

      // Register HTTP adapter
      const httpAdapterFactory =
        (httpAdapters as Record<string, (() => IHttpAdapter) | undefined>)[platform];
      if (httpAdapterFactory === undefined) {
        throw new Error(`No HTTP adapter for platform: ${platform}`);
      }
      const httpAdapter = httpAdapterFactory();
      ctx.services.register(CAPABILITIES.HTTP_ADAPTER, httpAdapter);
    },
  };
}
