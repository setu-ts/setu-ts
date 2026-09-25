/**
 * The `rest` project template.
 *
 * @module
 */
import type { MiddlewareWiring, TemplateDefinition, Wiring } from './registry.ts';
import { FUNCTIONAL_MODULE_MANIFEST } from './module-seam.ts';
import { REST_SHOWCASE, REST_SHOWCASE_FILES } from './rest-showcase.ts';
import { CLASS_BASED_SHOWCASE_EXAMPLE } from './class-based-showcase.ts';
import type { TemplateRecipe } from './style.ts';
import { composeHost } from './style.ts';

/**
 * Always first: the kernel makes the `runtime` capability mandatory at `start()`.
 *
 * On Cloudflare Workers it takes the Worker's `env`, which is the only way any
 * variable or secret reaches the application there — without it `runtime.env`
 * is empty and `ConfigPlugin` reads nothing. Object bindings (KV, R2, D1) are
 * filtered out of `runtime.env` and reached through `CloudflarePlugin`.
 */
export const RUNTIME_WIRING: Wiring = {
  pkg: 'runtime',
  symbol: 'RuntimePlugin',
  workersArgs: '{ env }',
};

/**
 * The REST plugin set, exported so `microservice` composes from it rather than
 * repeating the list.
 */
export const REST_PLUGINS: readonly Wiring[] = [
  RUNTIME_WIRING,
  // No `args` here on purpose: the dotenv path is template MANIFEST data, and
  // `configModule` renders it through one shared `renderConfigOptions`. A
  // literal here as well would be a second source of truth that `--env-file`
  // silently overrides.
  { pkg: 'config-plugin', symbol: 'ConfigPlugin' },
  { pkg: 'logger-plugin', symbol: 'LoggerPlugin' },
  // `errorFormat: 'rfc9457'` makes a validation failure answer in the same
  // Problem Details shape the `errorHandler` below emits for thrown errors
  // (C3): before this, the two disagreed on format in a scaffolded project.
  { pkg: 'validation-plugin', symbol: 'ValidationPlugin', args: "{ errorFormat: 'rfc9457' }" },
  { pkg: 'http-security-plugin', symbol: 'HttpSecurityPlugin' },
  { pkg: 'health-plugin', symbol: 'HealthPlugin' },
  { pkg: 'metrics-plugin', symbol: 'MetricsPlugin' },
  { pkg: 'openapi-plugin', symbol: 'OpenApiPlugin' },
];

/**
 * Middleware added with `app.middleware.add(...)`.
 *
 * Kept separate from the plugin list because `@setu-ts/exceptions`
 * ships a `MiddlewareFunction`, NOT an `IPlugin` — emitting
 * `ExceptionsPlugin()` would name a symbol that does not exist.
 */
export const REST_MIDDLEWARE: readonly MiddlewareWiring[] = [
  // `priority: 0` is load-bearing, not cosmetic: `errorHandler`'s contract
  // requires it be the OUTERMOST middleware. At the pipeline default of 500 it
  // sits inside every middleware these templates register — metrics (20),
  // ip-security (120), request-size (180), cors (200), security-headers (250),
  // csrf (270), plus telemetry (30) in the microservice set — so a throw from any
  // of them escapes to the adapter backstop: a bare 500 with no error body and
  // no error log. Nothing first-party registers at or below 0, so this slot is
  // unambiguous rather than merely early.
  {
    pkg: 'exceptions',
    symbol: 'errorHandler',
    args: "{ format: 'rfc9457' }",
    addOptions: { priority: 0, name: 'error-handler' },
  },
];

/**
 * The REST composition as data: the plugin set, middleware, manifest and the
 * per-style showcase.
 *
 * Both style hosts are built from this one recipe by {@linkcode composeHost},
 * so `rest` and `rest --style class-based` share every input and differ only
 * in what the style adds.
 */
export const REST_RECIPE: TemplateRecipe = {
  plugins: REST_PLUGINS,
  middleware: REST_MIDDLEWARE,
  manifest: FUNCTIONAL_MODULE_MANIFEST,
  showcase: {
    // The functional showcase reaches its plain service by a direct import,
    // exactly as the functional generators do.
    functional: {
      files: REST_SHOWCASE_FILES,
      seeded: { controller: [REST_SHOWCASE], service: [REST_SHOWCASE] },
    },
    // The class-based showcase is a decorated controller and an injected
    // service, seeded into the controller and service barrels.
    'class-based': CLASS_BASED_SHOWCASE_EXAMPLE,
  },
};

/**
 * `rest` — an opinionated REST API: configuration, logging, validation,
 * security headers, health probes, metrics, OpenAPI, and structured errors.
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
  ...composeHost(REST_RECIPE, 'functional'),
  classBased: composeHost(REST_RECIPE, 'class-based'),
};
