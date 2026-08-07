/**
 * @module
 */
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { IPlugin } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import { AuthPlugin } from '@setu-ts/auth-plugin';
import { DiPlugin } from '@setu-ts/di-plugin';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { SsePlugin } from '@setu-ts/sse-plugin';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';
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
  const plugins: IPlugin[] = [
    // Runtime must be first — the kernel requires it at start()
    RuntimePlugin(),

    // Core infrastructure (always-on)
    ConfigPlugin(options.config),
    LoggerPlugin(options.logger),
    ValidationPlugin(options.validation),
    HttpSecurityPlugin(options.httpSecurity),
    HealthPlugin(options.health),
    MetricsPlugin(options.metrics),
    OpenApiPlugin(options.openapi),
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
    ...(options.di ? [DiPlugin(options.di)] : []),
    ...(options.graphql ? [GraphqlPlugin(options.graphql)] : []),
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
  app.middleware.add(errorHandler({ format: 'rfc7807' }), { priority: 0, name: 'error-handler' });

  return app;
}
