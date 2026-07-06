/**
 * Application — the kernel entry point. Orchestrates plugin registration,
 * environment validation, middleware pipeline compilation, and request
 * handling with lifecycle hooks.
 *
 * @module
 */
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  CliCommandHandler,
  DecoratorHandler,
  EnvVarSpec,
  HealthIndicatorFn,
  IApplication,
  IConfig,
  IContainer,
  IHttpAdapter,
  ILogger,
  IMetadataStore,
  IMiddlewareApi,
  IPlugin,
  IPluginContext,
  IRouterApi,
  IRuntimeServices,
  MetricConfig,
  StartOptions,
} from '@hono-enterprise/common';
import type { IRequest } from '@hono-enterprise/common';

import { MiddlewarePipeline } from '../pipeline/middleware-pipeline.ts';
import { executeChain } from '../pipeline/execute-chain.ts';
import { resolvePluginOrder } from '../registry/plugin-resolver.ts';
import { ServiceRegistry } from '../registry/service-registry.ts';
import { Router } from '../router/router.ts';
import { LifecycleManager } from '../lifecycle/lifecycle-manager.ts';
import { createRequestContext } from '../context/request-context.ts';
import { ResponseBuilder } from '../context/response.ts';

/** Options for {@linkcode createApplication}. */
export interface ApplicationOptions {
  /** Plugins to pre-register before {@linkcode IApplication.start}. */
  plugins?: IPlugin[];
}

/**
 * Inject request shape for {@linkcode IKernelApplication.inject}.
 *
 * @since 0.1.0
 */
export interface InjectRequest {
  /** HTTP method. */
  method: string;
  /** Full request URL. */
  url: string;
  /** Request headers. */
  headers?: Record<string, string> | Headers;
  /** Request body (will be stringified if not a string). */
  body?: unknown;
}

/**
 * Inject response shape returned by {@linkcode IKernelApplication.inject}.
 *
 * @since 0.1.0
 */
export interface InjectResponse {
  /** Response status code. */
  readonly statusCode: number;
  /** Response headers. */
  readonly headers: Headers;
  /** Raw response body. */
  readonly body: string | null;
  /** Parse response body as JSON. */
  json<T>(): T;
}

/** Kernel application extends IApplication with inject() capability. */
export interface IKernelApplication extends IApplication {
  /**
   * Synthesizes an incoming request and runs it through the full pipeline
   * without requiring a listening server.
   *
   * @param request - The synthetic request
   * @returns The inject response
   */
  inject(request: InjectRequest): Promise<InjectResponse>;
}

// ---------------------------------------------------------------------------
// Application class (internal — not exported from index)
// ---------------------------------------------------------------------------

class Application implements IKernelApplication {
  readonly #registry = new ServiceRegistry();
  readonly #pipeline = new MiddlewarePipeline();
  readonly #router = new Router();
  readonly #lifecycle = new LifecycleManager();
  readonly #plugins: IPlugin[] = [];
  readonly #envSpecs: {
    name: string;
    spec: Readonly<Record<string, EnvVarSpec>>;
  }[] = [];
  #started = false;
  #serverHandle: unknown = null;
  #inFlight = 0;
  #stopping = false;

  get services() {
    return this.#registry;
  }

  get middleware(): IMiddlewareApi {
    return this.#pipeline;
  }

  get router(): IRouterApi {
    return this.#router;
  }

  register(plugin: IPlugin): IApplication {
    if (this.#started) {
      throw new Error('Cannot register plugins after the application has started.');
    }
    this.#plugins.push(plugin);
    return this;
  }

  async start(options?: StartOptions): Promise<void> {
    this.#started = true;

    // 1. Resolve plugin order — throws without runtime provider
    const ordered = resolvePluginOrder(this.#plugins);

    // The optional getters (config/logger/metadata/container) and the
    // mandatory runtime are resolved lazily via a Proxy. Runtime is fetched
    // on first access so the runtime-providing plugin (which registers
    // first) can populate CAPABILITIES.RUNTIME before any other plugin
    // touches ctx.runtime. Arrow functions below capture `this` lexically.
    const registry = this.#registry;
    const envSpecs = this.#envSpecs;
    const base: Omit<IPluginContext, 'config' | 'logger' | 'metadata' | 'container' | 'runtime'> = {
      services: registry,
      middleware: this.#pipeline,
      router: this.#router,
      lifecycle: this.#lifecycle,
      health: {
        register(name: string, indicator: HealthIndicatorFn): void {
          registry.register(
            CAPABILITIES.HEALTH_INDICATOR,
            { name, check: indicator },
            { multi: true },
          );
        },
      },
      metrics: {
        register(name: string, config: MetricConfig): void {
          registry.register(
            CAPABILITIES.METRIC_REGISTRATION,
            { name, config },
            { multi: true },
          );
        },
      },
      openapi: {
        addSchema(name: string, schema: unknown): void {
          registry.register(
            CAPABILITIES.OPENAPI_SCHEMA,
            { name, schema },
            { multi: true },
          );
        },
      },
      decorators: {
        register(name: string, handler: DecoratorHandler): void {
          registry.register(
            CAPABILITIES.DECORATOR_HANDLER,
            { name, handler },
            { multi: true },
          );
        },
      },
      cli: {
        register(name: string, handler: CliCommandHandler): void {
          registry.register(
            CAPABILITIES.CLI_COMMAND,
            { name, handler },
            { multi: true },
          );
        },
      },
      environment: {
        validate(spec: Readonly<Record<string, EnvVarSpec>>): void {
          envSpecs.push({ name: 'environment', spec });
        },
      },
      options: {},
      app: this,
    };

    const lazyGetters: Record<string, () => object> = {
      runtime: () => registry.get<IRuntimeServices>(CAPABILITIES.RUNTIME),
      config: () => registry.get<IConfig>(CAPABILITIES.CONFIG),
      logger: () => registry.get<ILogger>(CAPABILITIES.LOGGER),
      metadata: () => registry.get<IMetadataStore>(CAPABILITIES.METADATA_STORE),
      container: () => registry.get<IContainer>(CAPABILITIES.DI_CONTAINER),
    };
    const lazyAvailable: Record<string, () => boolean> = {
      runtime: () => registry.has(CAPABILITIES.RUNTIME),
      config: () => registry.has(CAPABILITIES.CONFIG),
      logger: () => registry.has(CAPABILITIES.LOGGER),
      metadata: () => registry.has(CAPABILITIES.METADATA_STORE),
      container: () => registry.has(CAPABILITIES.DI_CONTAINER),
    };

    const ctx: IPluginContext = new Proxy(base as Record<string, unknown>, {
      get(target, prop: string, receiver) {
        if (prop in lazyGetters) {
          return lazyAvailable[prop]() ? lazyGetters[prop]() : undefined;
        }
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop: string) {
        if (prop in lazyGetters) {
          return lazyAvailable[prop]();
        }
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        const keys = Reflect.ownKeys(target);
        for (const k of Object.keys(lazyGetters)) {
          if (lazyAvailable[k]() && !keys.includes(k)) {
            keys.push(k);
          }
        }
        return keys;
      },
      getOwnPropertyDescriptor(target, prop: string) {
        if (prop in lazyGetters) {
          if (!lazyAvailable[prop]()) {
            return undefined;
          }
          return {
            enumerable: true,
            configurable: true,
            writable: false,
            value: lazyGetters[prop](),
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    }) as unknown as IPluginContext;

    // 3. Register each plugin in resolved order
    for (const plugin of ordered) {
      await plugin.register(ctx);
    }

    // 4. Validate collected env specs against runtime.env
    const runtime = this.#registry.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    this.#validateEnvironment(runtime);

    // 5. Run init hooks
    await this.#lifecycle.runInit();

    // 6. Compile the middleware pipeline
    this.#pipeline.compile();

    // 7. Run bootstrap hooks
    await this.#lifecycle.runBootstrap();

    // 8. Listen only if adapter + port are available
    if (options?.port !== undefined && this.#registry.has(CAPABILITIES.HTTP_ADAPTER)) {
      const adapter = this.#registry.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
      this.#serverHandle = adapter.createServer((request: IRequest) =>
        this.#handleRequest(request)
      );
      await adapter.listen(this.#serverHandle, options.port, options.hostname);
    }
  }

  async stop(): Promise<void> {
    // No-op if the application never started (e.g. a failed start() or a
    // bare createApplication() used only for inject()). Avoids a confusing
    // "No service registered for capability 'runtime'" from #drainRequests.
    if (!this.#started) {
      return;
    }

    this.#stopping = true;

    // Wait for in-flight requests to drain (max 10s) only when a runtime
    // is available — it never is when start() never ran.
    if (this.#registry.has(CAPABILITIES.RUNTIME)) {
      await this.#drainRequests();
    }

    // Close server if listening
    if (this.#serverHandle !== null) {
      const adapter = this.#registry.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
      await adapter.close(this.#serverHandle);
      this.#serverHandle = null;
    }

    // Run shutdown hooks (LIFO)
    await this.#lifecycle.runShutdown();

    // Run close hooks
    await this.#lifecycle.runClose();
  }

  /** Synthesizes an inject request and runs it through the full pipeline. */
  async inject(request: InjectRequest): Promise<InjectResponse> {
    const bodyStr = typeof request.body === 'string'
      ? request.body
      : request.body !== undefined
      ? JSON.stringify(request.body)
      : undefined;

    const headers = request.headers instanceof Headers
      ? request.headers
      : new Headers(request.headers ?? {});

    if (bodyStr !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const syntheticRequest: IRequest = {
      method: request.method as IRequest['method'],
      url: request.url,
      get path() {
        return new URL(request.url).pathname;
      },
      headers,
      json<T>(): Promise<T> {
        return Promise.resolve(JSON.parse(bodyStr ?? '{}'));
      },
      text(): Promise<string> {
        return Promise.resolve(bodyStr ?? '');
      },
      bytes(): Promise<Uint8Array> {
        return Promise.resolve(new TextEncoder().encode(bodyStr ?? ''));
      },
    };

    const response = await this.#handleRequest(syntheticRequest);
    const snapshot = response.snapshot();

    return {
      statusCode: snapshot.status,
      headers: snapshot.headers,
      body: typeof snapshot.body === 'string' ? snapshot.body : null,
      json<T>(): T {
        if (snapshot.body === null || typeof snapshot.body !== 'string') {
          throw new Error('No JSON body available');
        }
        return JSON.parse(snapshot.body);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  async #handleRequest(request: IRequest): Promise<ResponseBuilder> {
    if (this.#stopping) {
      const builder = new ResponseBuilder();
      builder.status(503).json({ error: 'Service Unavailable' });
      return builder;
    }

    this.#inFlight++;
    const runtime = this.#registry.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    const handle = createRequestContext(request, this.#registry, runtime);
    const ctx = handle.ctx;

    try {
      // Run onRequest hooks
      for (const hook of this.#lifecycle.getRequestHooks()) {
        await hook(ctx);
      }

      // Execute pipeline with route dispatch as terminal
      await this.#pipeline.execute(ctx, async () => {
        const url = new URL(request.url);
        const routeResult = this.#router.match(request.method, url.pathname);

        if (routeResult === null) {
          ctx.response.status(404).json({ error: 'Not Found' });
          return;
        }

        // Install matched params via the internal setter (no readonly cast)
        const { definition, params } = routeResult;
        handle.setParams(params);

        // Route middleware uses the same next()-chaining semantics as the
        // global pipeline: a stage that responds without calling next()
        // short-circuits, and the handler does not run. Defense-in-depth
        // in executeChain also stops stages after the response is ended.
        await executeChain(
          definition.middleware ?? [],
          ctx,
          async () => {
            await definition.handler(ctx);
          },
        );
      });

      // Run onResponse hooks
      for (const hook of this.#lifecycle.getResponseHooks()) {
        await hook(ctx);
      }

      return ctx.response as ResponseBuilder;
    } catch (error) {
      // Run onError hooks (swallow their own errors)
      const err = error instanceof Error ? error : new Error(String(error));
      for (const hook of this.#lifecycle.getErrorHooks()) {
        try {
          await hook(err, ctx);
        } catch {
          // Swallow onError hook errors
        }
      }

      (ctx.response as ResponseBuilder).status(500).json({ error: 'Internal Server Error' });
      return ctx.response as ResponseBuilder;
    } finally {
      this.#inFlight--;
    }
  }

  #validateEnvironment(runtime: IRuntimeServices): void {
    const violations: string[] = [];

    for (const { name, spec } of this.#envSpecs) {
      for (const [key, rules] of Object.entries(spec)) {
        const value = runtime.env[key];

        if (value === undefined) {
          if (rules.required && rules.default === undefined) {
            violations.push(
              `Required environment variable '${key}' is missing (declared by ${name}).`,
            );
          }
          continue;
        }

        // Type coercion checks
        if (rules.type === 'number') {
          // `Number('')`, `Number('   ')`, and other blank strings coerce to
          // 0 (not NaN), so an empty/whitespace value would otherwise pass as
          // a valid number. Reject blanks explicitly, and use `isFinite` so
          // `Infinity`/`-Infinity` are rejected too.
          const num = Number(value);
          if (value.trim() === '' || !Number.isFinite(num)) {
            violations.push(
              `Environment variable '${key}' expected number but got '${value}' (declared by ${name}).`,
            );
          }
        } else if (rules.type === 'boolean') {
          if (value !== 'true' && value !== 'false') {
            violations.push(
              `Environment variable '${key}' expected boolean but got '${value}' (declared by ${name}).`,
            );
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Environment validation failed with ${violations.length} violation(s):\n` +
          violations.map((v) => `  - ${v}`).join('\n'),
      );
    }
  }

  async #drainRequests(): Promise<void> {
    const runtime = this.#registry.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    const deadline = runtime.now() + 10_000;
    // Iteration cap: a manual test clock that never advances would otherwise
    // spin forever (the deadline never arrives). 200 polls × 50ms ≈ 10s of
    // real polling under a normal clock, and a hard ceiling regardless.
    let polls = 0;
    const MAX_POLLS = 200;

    while (this.#inFlight > 0 && runtime.now() < deadline && polls < MAX_POLLS) {
      polls++;
      // Poll via runtime.setTimeout (max 10s)
      await new Promise<void>((resolve) => {
        runtime.setTimeout(() => resolve(), 50);
      });
    }
  }
}

/**
 * Creates a new kernel application instance.
 *
 * @param options - Optional application configuration including pre-registered plugins
 * @returns The kernel application instance with inject() capability
 * @example
 * ```typescript
 * import { createApplication } from '@hono-enterprise/kernel';
 *
 * const app = createApplication({
 *   plugins: [RuntimePlugin()],
 * });
 *
 * await app.start({ port: 3000 });
 * ```
 * @since 0.1.0
 */
export function createApplication(options?: ApplicationOptions): IKernelApplication {
  const app = new Application();
  if (options?.plugins) {
    for (const plugin of options.plugins) {
      app.register(plugin);
    }
  }
  return app;
}
