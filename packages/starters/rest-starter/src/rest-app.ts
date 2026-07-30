/**
 * @module
 */
import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import type { IPlugin } from '@hono-enterprise/common';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { ConfigPlugin } from '@hono-enterprise/config-plugin';
import { LoggerPlugin } from '@hono-enterprise/logger-plugin';
import { ValidationPlugin } from '@hono-enterprise/validation-plugin';
import { HttpSecurityPlugin } from '@hono-enterprise/http-security-plugin';
import { HealthPlugin } from '@hono-enterprise/health-plugin';
import { MetricsPlugin } from '@hono-enterprise/metrics-plugin';
import { OpenApiPlugin } from '@hono-enterprise/openapi-plugin';
import { DecoratorPlugin } from '@hono-enterprise/decorator-plugin';
import { DatabasePlugin } from '@hono-enterprise/database-plugin';
import { AuthPlugin } from '@hono-enterprise/auth-plugin';
import { errorHandler } from '@hono-enterprise/exceptions';
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

    // Gated arms — only added when explicitly provided
    ...(options.database ? [DatabasePlugin(options.database)] : []),
    ...(options.auth ? [AuthPlugin(options.auth)] : []),
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
 * import { createRestApp } from '@hono-enterprise/rest-starter';
 *
 * const app = createRestApp();
 * app.get('/hello', () => 'Hello world');
 * await app.start({ port: 3000 });
 * ```
 */
export function createRestApp(options?: RestStarterOptions): IKernelApplication {
  const plugins = buildRestPlugins(options ?? {});
  const app = createApplication({ plugins });

  // Add error handler as outermost middleware (priority 0) — required by
  // exceptions middleware contract to catch errors from all downstream middleware.
  app.middleware.add(errorHandler({ format: 'rfc7807' }), { priority: 0, name: 'error-handler' });

  return app;
}
