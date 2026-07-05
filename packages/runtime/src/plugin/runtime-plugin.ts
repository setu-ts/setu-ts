/**
 * RuntimePlugin — registers {@linkcode IRuntimeServices} under
 * `CAPABILITIES.RUNTIME` so every other plugin can rely on runtime-agnostic
 * services.
 *
 * @module
 */

import type {
  IPlugin,
  IPluginContext,
  IRuntimeServices,
  RuntimePlatform,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { detectRuntime } from '../detector/runtime-detector.ts';
import { createDenoRuntimeServices } from '../adapters/deno/deno-runtime.ts';
import { createNodeRuntimeServices } from '../adapters/node/node-runtime.ts';
import { createBunRuntimeServices } from '../adapters/bun/bun-runtime.ts';
import { createCloudflareRuntimeServices } from '../adapters/cloudflare/cf-runtime.ts';

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
   * Override adapter factories for testing. When provided, the plugin uses
   * these instead of the real adapter factories, allowing unit tests to
   * run without OS permissions or real runtime globals.
   *
   * @internal
   */
  adapters?: AdapterFactories;
}

/**
 * Map of platform → adapter factory. Used internally for dependency injection.
 */
export interface AdapterFactories {
  deno?: () => IRuntimeServices;
  node?: () => IRuntimeServices;
  bun?: () => IRuntimeServices;
  'cloudflare-workers'?: () => IRuntimeServices;
}

const defaultAdapters: AdapterFactories = {
  deno: () => createDenoRuntimeServices(),
  node: () => createNodeRuntimeServices(),
  bun: () => createBunRuntimeServices(),
  'cloudflare-workers': () => createCloudflareRuntimeServices(),
};

/**
 * Creates the RuntimePlugin that provides runtime-agnostic services.
 *
 * This plugin must be registered in every application. It has the highest
 * priority so its services are available to all other plugins during
 * registration.
 *
 * @param options - Optional configuration
 * @returns The runtime plugin
 * @throws {Error} If the resolved platform is `cloudflare-workers` (not yet
 *   implemented)
 */
export function RuntimePlugin(options?: RuntimeOptions): IPlugin {
  const platform: RuntimePlatform = options?.platform ?? detectRuntime();
  const adapters = options?.adapters ?? defaultAdapters;

  if (platform === 'cloudflare-workers') {
    throw new Error(
      'Cloudflare Workers runtime is not yet supported. ' +
        'Use a different platform or implement the Cloudflare adapter.',
    );
  }

  return {
    name: 'runtime',
    version: '0.1.0',
    provides: [CAPABILITIES.RUNTIME],
    priority: PLUGIN_PRIORITY.HIGHEST,

    register(ctx: IPluginContext): void {
      const factory = (adapters as Record<string, (() => IRuntimeServices) | undefined>)[platform];
      if (factory === undefined) {
        throw new Error(`No adapter factory for platform: ${platform}`);
      }
      const services = factory();
      ctx.services.register(CAPABILITIES.RUNTIME, services);
    },
  };
}
