/**
 * The plugin contract — the framework's central extension mechanism.
 * Everything is a plugin; the kernel only orchestrates registration.
 *
 * `IPlugin` and `IPluginContext` are defined here in `common` (never in the
 * kernel) so any package can implement or consume them without depending on
 * kernel internals.
 *
 * @module
 */
import type { CapabilityToken } from './tokens.ts';
import type { IServiceRegistry } from './registry.ts';
import type { HttpMethod } from './types.ts';
import type { IRequestContext, MiddlewareFunction, RouteDefinition, RouteHandler } from './http.ts';
import type { IRuntimeServices } from './runtime.ts';
import type { Constructor, IContainer } from './container.ts';
import type { ILogger } from './services/logger.ts';
import type { IConfig } from './services/config.ts';
import type { HealthIndicatorFn } from './services/health.ts';
import type { MetricConfig } from './services/metrics.ts';

/**
 * Options accepted when adding middleware to the pipeline.
 *
 * @since 0.1.0
 */
export interface MiddlewareOptions {
  /**
   * Execution priority — lower numbers run earlier. See ARCHITECTURE.md §10
   * for the conventional priority bands of first-party middleware.
   */
  readonly priority?: number;
  /** Diagnostic name shown in pipeline introspection. */
  readonly name?: string;
}

/**
 * Middleware pipeline registration surface exposed to plugins.
 *
 * @since 0.1.0
 */
export interface IMiddlewareApi {
  /**
   * Adds middleware to the global pipeline.
   *
   * @param middleware - The middleware function
   * @param options - Priority and diagnostics
   */
  add(middleware: MiddlewareFunction, options?: MiddlewareOptions): void;
}

/**
 * Router registration surface exposed to plugins and applications.
 *
 * Every verb method accepts either a bare handler or a full
 * {@linkcode RouteDefinition} with middleware and schemas.
 *
 * @since 0.1.0
 */
/**
 * Route information returned by {@linkcode IRouterApi.listRoutes}.
 *
 * @since 0.1.0
 */
export interface RouteInfo {
  /** HTTP method of the route. */
  readonly method: HttpMethod;
  /** Route path pattern (router-style with `:param` segments). */
  readonly path: string;
  /** The route definition including handler, middleware, and schema. */
  readonly definition: RouteDefinition;
}

export interface IRouterApi {
  /**
   * Registers a GET route.
   *
   * @param path - Route path; `:name` segments become path parameters
   * @param route - Handler or full route definition
   */
  get(path: string, route: RouteHandler | RouteDefinition): void;
  /**
   * Registers a POST route.
   *
   * @param path - Route path
   * @param route - Handler or full route definition
   */
  post(path: string, route: RouteHandler | RouteDefinition): void;
  /**
   * Registers a PUT route.
   *
   * @param path - Route path
   * @param route - Handler or full route definition
   */
  put(path: string, route: RouteHandler | RouteDefinition): void;
  /**
   * Registers a PATCH route.
   *
   * @param path - Route path
   * @param route - Handler or full route definition
   */
  patch(path: string, route: RouteHandler | RouteDefinition): void;
  /**
   * Registers a DELETE route.
   *
   * @param path - Route path
   * @param route - Handler or full route definition
   */
  delete(path: string, route: RouteHandler | RouteDefinition): void;
  /**
   * Registers a HEAD route.
   *
   * @param path - Route path
   * @param route - Handler or full route definition
   */
  head(path: string, route: RouteHandler | RouteDefinition): void;
  /**
   * Registers an OPTIONS route.
   *
   * @param path - Route path
   * @param route - Handler or full route definition
   */
  options(path: string, route: RouteHandler | RouteDefinition): void;
  /**
   * Creates a route group: routes registered inside the callback share the
   * prefix and any group middleware.
   *
   * @param prefix - Path prefix for every route in the group
   * @param configure - Receives a router scoped to the prefix
   */
  group(prefix: string, configure: (router: IRouterApi) => void): void;
  /**
   * Returns all registered routes for introspection.
   *
   * Used by the OpenAPI plugin to generate documentation from route definitions.
   *
   * @returns Immutable array of route information in registration order
   * @since 0.1.0
   */
  listRoutes(): readonly RouteInfo[];
}

/**
 * Specification of one environment variable for
 * {@linkcode IEnvironmentApi.validate}.
 *
 * @since 0.1.0
 */
export interface EnvVarSpec {
  /** Whether the variable must be present. */
  readonly required?: boolean;
  /** Expected primitive type (defaults to `'string'`). */
  readonly type?: 'string' | 'number' | 'boolean';
  /** Default applied when the variable is absent. */
  readonly default?: string | number | boolean;
}

/**
 * Environment validation surface: plugins declare the environment variables
 * they need, and the kernel validates them at startup, failing fast on
 * violations.
 *
 * @since 0.1.0
 */
export interface IEnvironmentApi {
  /**
   * Declares and validates environment variables.
   *
   * @param spec - Variable specifications keyed by variable name
   * @throws {Error} At startup when a required variable is missing or mistyped
   */
  validate(spec: Readonly<Record<string, EnvVarSpec>>): void;
}

/**
 * Health check registration surface.
 *
 * @since 0.1.0
 */
export interface IHealthApi {
  /**
   * Registers a health indicator.
   *
   * @param name - Indicator name, unique per application
   * @param indicator - Function producing the health check result
   */
  register(name: string, indicator: HealthIndicatorFn): void;
}

/**
 * Metric registration surface.
 *
 * @since 0.1.0
 */
export interface IMetricsApi {
  /**
   * Registers a metric.
   *
   * @param name - Metric name (Prometheus naming conventions)
   * @param config - Metric type, help text, labels
   */
  register(name: string, config: MetricConfig): void;
}

/**
 * OpenAPI contribution surface. Schema values are `unknown` here; the
 * OpenAPI plugin narrows them (Zod schemas by default).
 *
 * @since 0.1.0
 */
export interface IOpenApiApi {
  /**
   * Contributes a named schema to the generated OpenAPI document.
   *
   * @param name - Component schema name
   * @param schema - The schema (Zod schema by default)
   */
  addSchema(name: string, schema: unknown): void;
}

/**
 * Handler invoked when a custom decorator is applied; receives the metadata
 * the decorator captured.
 *
 * @since 0.1.0
 */
export type DecoratorHandler = (
  metadata: Readonly<Record<string, unknown>>,
  target: object,
  propertyKey?: string,
) => void;

/**
 * Custom decorator registration surface (active only when the
 * DecoratorPlugin is registered; inert otherwise).
 *
 * @since 0.1.0
 */
export interface IDecoratorApi {
  /**
   * Registers a handler for a custom decorator.
   *
   * @param name - Decorator name
   * @param handler - Invoked with the decorator's captured metadata
   */
  register(name: string, handler: DecoratorHandler): void;
}

/**
 * A CLI command implementation.
 *
 * @param args - Positional arguments after the command name
 * @returns Optionally async completion
 * @since 0.1.0
 */
export type CliCommandHandler = (args: readonly string[]) => void | Promise<void>;

/**
 * CLI command registration surface, consumed by the CLI tool to discover
 * plugin-provided commands.
 *
 * @since 0.1.0
 */
export interface ICliApi {
  /**
   * Registers a CLI command.
   *
   * @param name - Command name (convention: `plugin:command`)
   * @param handler - Command implementation
   */
  register(name: string, handler: CliCommandHandler): void;
}

/**
 * Lifecycle hook registration surface. Hooks run in registration order
 * within each phase.
 *
 * @since 0.1.0
 */
export interface ILifecycleApi {
  /**
   * Runs during the owning plugin's registration.
   *
   * @param fn - Hook body
   */
  onRegister(fn: () => void | Promise<void>): void;
  /**
   * Runs after all plugins have registered.
   *
   * @param fn - Hook body
   */
  onInit(fn: () => void | Promise<void>): void;
  /**
   * Runs immediately before the server starts listening.
   *
   * @param fn - Hook body
   */
  onBootstrap(fn: () => void | Promise<void>): void;
  /**
   * Runs at the start of every request.
   *
   * @param fn - Hook body receiving the request context
   */
  onRequest(fn: (ctx: IRequestContext) => void | Promise<void>): void;
  /**
   * Runs after every response is produced.
   *
   * @param fn - Hook body receiving the request context
   */
  onResponse(fn: (ctx: IRequestContext) => void | Promise<void>): void;
  /**
   * Runs when an error escapes middleware or a handler.
   *
   * @param fn - Hook body receiving the error and request context
   */
  onError(fn: (error: Error, ctx: IRequestContext) => void | Promise<void>): void;
  /**
   * Runs when shutdown begins — close connections, flush buffers here.
   *
   * @param fn - Hook body
   */
  onShutdown(fn: () => void | Promise<void>): void;
  /**
   * Runs after shutdown completes.
   *
   * @param fn - Hook body
   */
  onClose(fn: () => void | Promise<void>): void;
}

/**
 * Metadata captured by decorators, read by the DecoratorPlugin. Stored in
 * plain maps — no reflection (ARCHITECTURE.md §12). The concrete metadata
 * value shapes are owned by the decorator plugin.
 *
 * @since 0.1.0
 */
export interface IMetadataStore {
  /** Controller metadata keyed by class. */
  readonly controllers: Map<Constructor, Readonly<Record<string, unknown>>>;
  /** Service metadata keyed by class. */
  readonly services: Map<Constructor, Readonly<Record<string, unknown>>>;
  /** Route metadata lists keyed by controller class. */
  readonly routes: Map<Constructor, ReadonlyArray<Readonly<Record<string, unknown>>>>;
}

/**
 * Options for starting the application server.
 *
 * @since 0.1.0
 */
export interface StartOptions {
  /** TCP port to listen on. */
  readonly port?: number;
  /** Bind address (defaults to all interfaces). */
  readonly hostname?: string;
}

/**
 * The application: registers plugins, owns the router and middleware
 * pipeline, and manages the server lifecycle.
 *
 * @since 0.1.0
 */
export interface IApplication {
  /** The application router. */
  readonly router: IRouterApi;
  /** The global middleware pipeline. */
  readonly middleware: IMiddlewareApi;
  /** The application-scoped service registry. */
  readonly services: IServiceRegistry;
  /**
   * Registers a plugin. Plugins register when the application starts, in
   * dependency order.
   *
   * @param plugin - The plugin to register
   * @returns This application, for chaining
   */
  register(plugin: IPlugin): IApplication;
  /**
   * Resolves plugins, builds the pipeline and router, and starts the server.
   *
   * @param options - Port and hostname
   * @throws {Error} If plugin dependencies are unsatisfied or cyclic, or if
   * no plugin provides the `runtime` capability
   */
  start(options?: StartOptions): Promise<void>;
  /**
   * Stops the server and runs shutdown hooks.
   */
  stop(): Promise<void>;
}

/**
 * The registration context handed to {@linkcode IPlugin.register} — every
 * extension point a plugin can touch.
 *
 * @since 0.1.0
 */
export interface IPluginContext {
  /** Service registration and resolution. */
  readonly services: IServiceRegistry;
  /** Middleware pipeline. */
  readonly middleware: IMiddlewareApi;
  /** Route registration. */
  readonly router: IRouterApi;
  /** Environment variable validation. */
  readonly environment: IEnvironmentApi;
  /** Health check registration. */
  readonly health: IHealthApi;
  /** Metric registration. */
  readonly metrics: IMetricsApi;
  /** OpenAPI contributions. */
  readonly openapi: IOpenApiApi;
  /** Custom decorator registration. */
  readonly decorators: IDecoratorApi;
  /** CLI command registration. */
  readonly cli: ICliApi;
  /** Lifecycle hooks. */
  readonly lifecycle: ILifecycleApi;
  /**
   * Runtime services. Non-optional by contract: a runtime provider is
   * mandatory and the kernel registers it first, so every other plugin can
   * rely on it during registration (see ARCHITECTURE.md §7).
   */
  readonly runtime: IRuntimeServices;
  /** Configuration access (from the ConfigPlugin, when registered). */
  readonly config?: IConfig;
  /** Logger (from the LoggerPlugin, when registered). */
  readonly logger?: ILogger;
  /** Decorator metadata store (from the DecoratorPlugin, when registered). */
  readonly metadata?: IMetadataStore;
  /** DI container (from the DiPlugin, when registered). */
  readonly container?: IContainer;
  /** Options the application passed to this plugin's factory. */
  readonly options: Readonly<Record<string, unknown>>;
  /** The owning application. */
  readonly app: IApplication;
}

/**
 * The plugin contract. Every framework capability implements this interface
 * (AI_GUIDELINES §3.2).
 *
 * @example
 * ```typescript
 * export function MyPlugin(options: MyPluginOptions): IPlugin {
 *   return {
 *     name: 'my-plugin',
 *     version: '1.0.0',
 *     dependencies: [CAPABILITIES.LOGGER],
 *     provides: ['my-capability'],
 *     register(ctx) {
 *       ctx.services.register('my-capability', new MyService(options));
 *     },
 *   };
 * }
 * ```
 * @since 0.1.0
 */
export interface IPlugin {
  /** Unique plugin name, lowercase kebab-case. */
  readonly name: string;
  /** Plugin semver, matching its `deno.json` version. */
  readonly version: string;
  /** Capability tokens that must be provided before this plugin registers. */
  readonly dependencies?: readonly CapabilityToken[];
  /** Capability tokens used when present, tolerated when absent. */
  readonly optionalDependencies?: readonly CapabilityToken[];
  /** Capability tokens this plugin registers. */
  readonly provides?: readonly CapabilityToken[];
  /** Capability tokens this plugin resolves at runtime. */
  readonly consumes?: readonly CapabilityToken[];
  /** Registration priority within the same dependency level; lower first. */
  readonly priority?: number;
  /**
   * Registers the plugin's services, middleware, routes, and hooks.
   *
   * @param ctx - The plugin context
   */
  register(ctx: IPluginContext): void | Promise<void>;
}
