/**
 * The `rest` project template.
 *
 * @module
 */

import type { MiddlewareWiring, TemplateDefinition, Wiring } from './registry.ts';

/** Always first: the kernel makes the `runtime` capability mandatory at `start()`. */
export const RUNTIME_WIRING: Wiring = { pkg: 'runtime', symbol: 'RuntimePlugin' };

/**
 * The REST plugin set, exported so `microservice` composes from it rather than
 * repeating the list.
 */
export const REST_PLUGINS: readonly Wiring[] = [
  RUNTIME_WIRING,
  { pkg: 'config-plugin', symbol: 'ConfigPlugin' },
  { pkg: 'logger-plugin', symbol: 'LoggerPlugin' },
  { pkg: 'validation-plugin', symbol: 'ValidationPlugin' },
  { pkg: 'http-security-plugin', symbol: 'HttpSecurityPlugin' },
  { pkg: 'health-plugin', symbol: 'HealthPlugin' },
  { pkg: 'metrics-plugin', symbol: 'MetricsPlugin' },
  { pkg: 'openapi-plugin', symbol: 'OpenApiPlugin' },
  // Present so `honoe generate controller` works in a scaffolded REST project:
  // that schematic emits @Controller/@Get/@Post and is gated on this package.
  { pkg: 'decorator-plugin', symbol: 'DecoratorPlugin' },
];

/**
 * Middleware added with `app.middleware.add(...)`.
 *
 * Kept separate from the plugin list because `@hono-enterprise/exceptions`
 * ships a `MiddlewareFunction`, NOT an `IPlugin` — emitting
 * `ExceptionsPlugin()` would name a symbol that does not exist.
 */
export const REST_MIDDLEWARE: readonly MiddlewareWiring[] = [
  // `priority: 0` is load-bearing, not cosmetic: `errorHandler`'s contract
  // requires it be the OUTERMOST middleware. At the pipeline default of 500 it
  // sits inside every middleware these templates register — metrics (20),
  // ip-security (120), request-size (180), cors (200), security-headers (250),
  // csrf (270), plus telemetry (30) in the microservice set — so a throw from any
  // of them escapes to the adapter backstop: a bare 500 with no RFC 7807 body and
  // no error log. Nothing first-party registers at or below 0, so this slot is
  // unambiguous rather than merely early.
  { pkg: 'exceptions', symbol: 'errorHandler', addOptions: { priority: 0, name: 'error-handler' } },
];

/**
 * `rest` — an opinionated REST API: configuration, logging, validation,
 * security headers, health probes, metrics, OpenAPI, and RFC 7807 errors.
 *
 * `database-plugin` and `auth-plugin` are deliberately absent despite the
 * ROADMAP's REST starter listing them: both need real credentials before they
 * do anything, so scaffolding them yields a project that starts and then fails
 * at first use. Every plugin here constructs with no configuration.
 *
 * Supported on all four runtime targets.
 */
export const REST_TEMPLATE: TemplateDefinition = {
  name: 'rest',
  description: 'REST API — config, logging, validation, security, health, metrics, OpenAPI',
  plugins: REST_PLUGINS,
  middleware: REST_MIDDLEWARE,
  unsupported: {},
};
