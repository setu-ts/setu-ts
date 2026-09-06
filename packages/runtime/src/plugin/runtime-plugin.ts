/**
 * RuntimePlugin — registers {@linkcode IRuntimeServices} under
 * `CAPABILITIES.RUNTIME` and {@linkcode IHttpAdapter} under
 * `CAPABILITIES.HTTP_ADAPTER` so every other plugin can rely on runtime-agnostic
 * services and HTTP server capabilities.
 *
 * @module
 */

import type { IHttpAdapter, IPlugin, IPluginContext, RuntimePlatform } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';

import { detectRuntime } from '../detector/runtime-detector.ts';
import type { HttpAdapterOptions } from '../adapters/shared/adapter-options.ts';
import type { RuntimeAdapterFactories } from '../adapters/shared/runtime-services-factory.ts';
import { createRuntimeServices } from '../adapters/shared/runtime-services-factory.ts';
import { DenoHttpAdapter } from '../adapters/deno/deno-http-adapter.ts';
import { NodeHttpAdapter } from '../adapters/node/node-http-adapter.ts';
import { BunHttpAdapter } from '../adapters/bun/bun-http-adapter.ts';
import { CloudflareWorkersHttpAdapter } from '../adapters/workers/cf-http-adapter.ts';
import denoJson from '../../deno.json' with { type: 'json' };

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
  /**
   * The Cloudflare Workers `env` record. There is no ambient environment on
   * the edge, so without this `runtime.env` is empty on Workers and
   * `ConfigPlugin` reads nothing.
   *
   * Pass what the platform provides — `import { env } from 'cloudflare:workers'`
   * — and only its **string** entries populate `runtime.env`. Object bindings
   * (KV, R2, D1, …) are published separately by `CloudflarePlugin` under
   * `CAPABILITIES.CLOUDFLARE`, because `IRuntimeServices.env` is contracted as
   * a string record.
   *
   * Ignored on Deno, Node, and Bun.
   *
   * @example
   * ```typescript
   * import { env } from 'cloudflare:workers';
   *
   * const app = createApplication({ plugins: [RuntimePlugin({ env })] });
   * ```
   * @since 0.2.0
   */
  env?: Readonly<Record<string, unknown>>;
  /**
   * Maximum request-body size, in bytes, enforced where the body is read.
   * Omitted, the read is unbounded — the released behaviour, byte for byte.
   *
   * This is the layer no request header can switch off.
   * `HttpSecurityPlugin({ requestSize: { maxBodySize } })` refuses on a
   * DECLARED `Content-Length` before anything is read, which is cheaper and
   * reports earlier — but a chunked request declares no length, and since M87
   * made the body lazy the read happens inside the handler, after every
   * middleware has returned. So a chunked body can only be bounded here.
   *
   * The two knobs exist because the mapping runs before any plugin and there
   * is no channel between them: `mapWebRequestToFrameworkRequest` receives a
   * `Request` and nothing else. Set both, and set this one to the same value
   * or higher.
   *
   * A body past the cap rejects with `RequestBodyTooLargeError`, branded with
   * a `413` status hint, so an application running `errorHandler` answers
   * `413 Content Too Large` in its configured format.
   *
   * @example
   * ```typescript
   * RuntimePlugin({ maxBodyBytes: 10 * 1024 * 1024 })
   * ```
   * @since 0.5.0
   */
  maxBodyBytes?: number;
}

/**
 * Map of platform → HTTP adapter factory. Used internally for dependency injection.
 */
export interface HttpAdapterFactories {
  deno?: (options?: HttpAdapterOptions) => IHttpAdapter;
  node?: (options?: HttpAdapterOptions) => IHttpAdapter;
  bun?: (options?: HttpAdapterOptions) => IHttpAdapter;
  'cloudflare-workers'?: (options?: HttpAdapterOptions) => IHttpAdapter;
}

// Each factory takes the adapter options the plugin resolved. The parameter is
// optional, so an injected zero-argument fake — which is what every test in
// this repository supplies — stays assignable.
const defaultHttpAdapters: HttpAdapterFactories = {
  deno: (options) => new DenoHttpAdapter(undefined, options),
  node: (options) => new NodeHttpAdapter(undefined, undefined, options),
  bun: (options) => new BunHttpAdapter(undefined, options),
  'cloudflare-workers': (options) => new CloudflareWorkersHttpAdapter(undefined, options),
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
  const workerEnv = options?.env;
  const maxBodyBytes = options?.maxBodyBytes;

  return {
    name: 'runtime',
    version: denoJson.version,
    provides: [CAPABILITIES.RUNTIME, CAPABILITIES.HTTP_ADAPTER],
    priority: PLUGIN_PRIORITY.HIGHEST,

    register(ctx: IPluginContext): void {
      // Register runtime services. Built through the shared factory rather than
      // a second copy of the platform → adapter map, so a caller that needs
      // services before start() (config resolution) gets the same resolution
      // this plugin does.
      const services = createRuntimeServices({
        platform,
        // `exactOptionalPropertyTypes`: omit each entirely rather than passing
        // undefined, so the factory's own defaults apply.
        ...(runtimeAdapters === undefined ? {} : { adapters: runtimeAdapters }),
        ...(workerEnv === undefined ? {} : { env: workerEnv }),
      });
      ctx.services.register(CAPABILITIES.RUNTIME, services);

      // Register HTTP adapter
      const httpAdapterFactory = (httpAdapters as Record<
        string,
        ((adapterOptions?: HttpAdapterOptions) => IHttpAdapter) | undefined
      >)[platform];
      if (httpAdapterFactory === undefined) {
        throw new Error(`No HTTP adapter for platform: ${platform}`);
      }
      // `exactOptionalPropertyTypes`: omit the member entirely when unset, so
      // an adapter reading `options?.maxBodyBytes` sees the same `undefined`
      // either way and no caller can pass an explicit `undefined`.
      const httpAdapter = httpAdapterFactory(
        maxBodyBytes === undefined ? {} : { maxBodyBytes },
      );
      ctx.services.register(CAPABILITIES.HTTP_ADAPTER, httpAdapter);
    },
  };
}
