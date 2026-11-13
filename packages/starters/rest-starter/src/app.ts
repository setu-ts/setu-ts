/**
 * @module
 */
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { IPlugin, RuntimePlatform } from '@setu-ts/common';
import { detectRuntime, RuntimePlugin } from '@setu-ts/runtime';
import type { RuntimeOptions } from '@setu-ts/runtime';
import type { HttpSecurityPluginOptions } from '@setu-ts/http-security-plugin';
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
import type { OpenApiPluginOptions } from '@setu-ts/openapi-plugin';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import { AuthPlugin } from '@setu-ts/auth-plugin';
import { DiPlugin } from '@setu-ts/di-plugin';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { SsePlugin } from '@setu-ts/sse-plugin';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import type { RestStarterOptions } from './options.ts';

/**
 * Builds the canonical REST plugin set. The list is exported so the microservice
 * starter can compose from it without duplication.
 *
 * @param options - Optional per-plugin configuration arms. Omitted plugins use defaults.
 * @returns Array of {@linkcode IPlugin} instances in registration order.
 */
export function buildRestPlugins(options: RestStarterOptions = {}): IPlugin[] {
  // The platform RuntimePlugin will run on: an explicit `runtime.platform`
  // wins, so the starter's own platform choices agree with it.
  return composeRestPlugins(options, options.runtime?.platform ?? detectRuntime());
}

/**
 * Chooses the OpenAPI options for a platform. Swagger UI self-hosts by default,
 * which reads `swagger-ui-dist` through `runtime.fs`; Workers has no `fs`, so a
 * caller who did not choose an asset mode gets the pinned CDN assets there.
 * `swagger: false` and an explicit `assets` value are kept; `true` and `{}`
 * name no asset mode, so they get the CDN too.
 *
 * `errorSchema: 'rfc9457'` is the default, because the starter's
 * `ValidationPlugin` and `errorHandler` both answer in RFC 9457 format; a
 * caller's own `errorSchema` still wins (M137b §3.8).
 *
 * @internal
 * @param openapi - The caller's OpenAPI options, if any.
 * @param platform - The platform the application runs on.
 * @returns The options to construct {@linkcode OpenApiPlugin} with.
 */
export function openApiOptionsFor(
  openapi: OpenApiPluginOptions | undefined,
  platform: RuntimePlatform,
): OpenApiPluginOptions {
  const swagger = openapi?.swagger;
  if (
    platform !== 'cloudflare-workers' ||
    swagger === false ||
    (typeof swagger === 'object' && swagger.assets !== undefined)
  )
    return { errorSchema: 'rfc9457', ...openapi };
  return {
    errorSchema: 'rfc9457',
    ...openapi,
    swagger: { ...(typeof swagger === 'object' ? swagger : {}), assets: 'cdn' },
  };
}

/**
 * The request-body bound every starter applies unless the application chooses
 * another: 1 MiB, the same as `requestSizeMiddleware`'s default.
 * @internal
 */
export const DEFAULT_STARTER_MAX_BODY_BYTES = 1_048_576;

/**
 * The options the starter constructs `RuntimePlugin` with: the default body
 * bound, overridden by the caller's `runtime` arm.
 * @internal
 * @param options - The starter options
 * @returns The runtime options, always carrying `maxBodyBytes`
 */
export function starterRuntimeOptions(
  options: RestStarterOptions,
): RuntimeOptions & { readonly maxBodyBytes: number } {
  const maxBodyBytes = options.runtime?.maxBodyBytes ?? DEFAULT_STARTER_MAX_BODY_BYTES;
  return { ...options.runtime, maxBodyBytes };
}

/**
 * The options the starter constructs `HttpSecurityPlugin` with: the caller's,
 * plus a declared-length check at the runtime body bound when the caller
 * supplied no `requestSize`. The runtime bound covers chunked bodies; this
 * check refuses a declared oversize body before anything is read.
 * @internal
 * @param options - The starter options
 * @returns The HTTP security options
 */
export function starterHttpSecurityOptions(options: RestStarterOptions): HttpSecurityPluginOptions {
  const security = options.httpSecurity;
  const requestSize = security?.requestSize;
  // An explicit bound or an explicit opt-out is kept as given. A `requestSize`
  // that names neither (`{}`, `{ enabled: true }`) takes the runtime bound
  // rather than the middleware's own 1 MiB, which would refuse what a raised
  // `runtime.maxBodyBytes` admits.
  if (
    security !== undefined &&
    (requestSize?.maxBodySize !== undefined || requestSize?.enabled === false)
  ) {
    return security;
  }
  return {
    ...security,
    requestSize: { ...requestSize, maxBodySize: starterRuntimeOptions(options).maxBodyBytes },
  };
}

/**
 * Builds the REST plugin set for an already-detected platform. Internal:
 * taking the platform as a parameter is what lets a test reach the Workers
 * branch, since `detectRuntime()` never answers Workers under the suite.
 *
 * @internal
 * @param options - Optional per-plugin configuration arms.
 * @param platform - The platform the application runs on.
 * @returns Array of {@linkcode IPlugin} instances in registration order.
 */
export function composeRestPlugins(
  options: RestStarterOptions,
  platform: RuntimePlatform,
): IPlugin[] {
  const plugins: IPlugin[] = [
    // Runtime must be first — the kernel requires it at start()
    RuntimePlugin(starterRuntimeOptions(options)),

    // Core infrastructure (always-on)
    ConfigPlugin(options.config),
    LoggerPlugin(options.logger),
    // `errorFormat: 'rfc9457'` makes a validation failure answer in the same
    // Problem Details shape the `errorHandler` below emits for thrown errors
    // (C3). `options.validation` spreads LAST so an explicit caller option —
    // including its own `errorFormat` — still wins.
    ValidationPlugin({ errorFormat: 'rfc9457', ...options.validation }),
    HttpSecurityPlugin(starterHttpSecurityOptions(options)),
    HealthPlugin(options.health),
    MetricsPlugin(options.metrics),
    OpenApiPlugin(openApiOptionsFor(options.openapi, platform)),
    DecoratorPlugin(options.decorators),

    // Gated arms — only added when explicitly provided.
    //
    // Array position does not establish registration order: the kernel's plugin
    // resolver sorts by `priority` ascending and only then by registration
    // order. So DiPlugin (NORMAL, 500) registers before DecoratorPlugin (LOW,
    // 900) and the backplane (HIGH, 100) before its two consumers, wherever
    // they sit in this list.
    ...(options.database ? [DatabasePlugin(options.database)] : []),
    ...(options.auth ? [AuthPlugin(options.auth)] : []),
    ...(options.session ? [SessionPlugin(options.session)] : []),
    // DiPlugin's own `autoRegister: true` default is what lets an @Injectable
    // class @Inject(CAPABILITIES.X); the options pass through unchanged.
    ...(options.di ? [DiPlugin(options.di)] : []),
    ...(options.graphql ? [GraphqlPlugin(options.graphql)] : []),
    ...(options.serviceDiscovery ? [ServiceDiscoveryPlugin(options.serviceDiscovery)] : []),
    ...(options.realtime?.backplane ? [RealtimeBackplanePlugin(options.realtime.backplane)] : []),
    ...(options.realtime?.websocket ? [WebSocketPlugin(options.realtime.websocket)] : []),
    ...(options.realtime?.sse ? [SsePlugin(options.realtime.sse)] : []),
  ];

  return plugins;
}

/**
 * Creates a fully wired REST application. The factory registers the curated
 * REST plugin set, adds the error-handler middleware at priority 0 (outermost
 * per the exceptions contract), and returns the un-started application.
 *
 * The caller adds routes and then calls `await app.start({ port })`.
 *
 * @param options - Optional per-plugin configuration.
 * @returns An {@linkcode IKernelApplication} ready for route registration.
 * @example
 * ```typescript
 * import { createRestApp } from '@setu-ts/rest-starter';
 *
 * const app = createRestApp();
 * app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));
 * await app.start({ port: 3000 });
 * ```
 */
export function createRestApp(options?: RestStarterOptions): IKernelApplication {
  const plugins = buildRestPlugins(options);
  const app = createApplication({ plugins });

  // Add error handler as outermost middleware (priority 0) — required by
  // exceptions middleware contract to catch errors from all downstream middleware.
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0, name: 'error-handler' });

  return app;
}
