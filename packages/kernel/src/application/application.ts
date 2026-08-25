/**
 * Application — the kernel entry point. Orchestrates plugin registration,
 * environment validation, middleware pipeline compilation, and request
 * handling with lifecycle hooks.
 *
 * @module
 */
import {
  CAPABILITIES,
  ERROR_RESPONDER_STATE_KEY,
  errorResponderOf,
  respondWithError,
  serializeError,
  setUpgradeIntent,
} from '@setu-ts/common';
import type {
  CliCommandHandler,
  DecoratorHandler,
  EnvVarSpec,
  HealthIndicatorFn,
  IApplication,
  IConfig,
  IContainer,
  IErrorResponder,
  IHttpAdapter,
  ILogger,
  IMetadataStore,
  IMiddlewareApi,
  IPlugin,
  IPluginContext,
  IRequest,
  IRequestContext,
  IRouterApi,
  IRuntimeServices,
  IWebSocketService,
  MetricConfig,
  StartOptions,
  WebSocketUpgradeDecision,
} from '@setu-ts/common';
import type { IGrpcService } from '@setu-ts/common';

import { MiddlewarePipeline } from '../pipeline/middleware-pipeline.ts';
import { executeChain } from '../pipeline/execute-chain.ts';
import { findUnsatisfiedConsumers, resolvePluginOrder } from '../registry/plugin-resolver.ts';
import { ServiceRegistry } from '../registry/service-registry.ts';
import { Router } from '../router/router.ts';
import { isPathDecodable } from '../router/route-matcher.ts';
import { LifecycleManager } from '../lifecycle/lifecycle-manager.ts';
import { createRequestContext } from '../context/request-context.ts';
import type { RequestContextHandle } from '../context/request-context.ts';
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
  /**
   * Raw response body as text. A byte body (from `response.send(bytes)`) is
   * UTF-8 decoded; `null` only when the response genuinely has no body.
   */
  readonly body: string | null;
  /**
   * Parses the response body as JSON.
   *
   * @throws {Error} If the response has no body
   * @throws {SyntaxError} If the body is not valid JSON
   */
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
  #registeringPlugin: string | undefined;
  readonly #router = new Router(() => this.#registeringPlugin);
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
  /** Cached in-flight/completed shutdown, so stop() runs its side effects once. */
  #stopPromise: Promise<void> | null = null;
  /**
   * The application's resolved error responder, read from the compiled
   * pipeline's `errorHandler` brand at startup (M70f re-review, findings 1 & 2).
   *
   * `errorHandler` publishes its responder into `ctx.state` per request, but
   * three kernel sites run BEFORE any middleware: the shutdown-drain `503`,
   * the malformed-request `400`, and the request-lifecycle hooks. Those sites
   * cannot read `ctx.state` (no context yet, or the context is fresh), so the
   * kernel seeds the SAME resolved responder into their state from this cache.
   * `undefined` when no `errorHandler` is registered, in which case every site
   * keeps the byte-identical no-handler fallback.
   */
  #errorResponder: IErrorResponder | undefined = undefined;

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
    if (this.#started) {
      throw new Error('Application has already been started.');
    }
    // Mark as started up-front so plugins cannot register more plugins during
    // startup, but roll it back if any startup step throws (see the catch
    // below) so a failed start can be corrected and retried instead of
    // wedging the application.
    this.#started = true;
    try {
      await this.#runStartup(options);
    } catch (error) {
      this.#started = false;
      throw error;
    }
  }

  async #runStartup(options?: StartOptions): Promise<void> {
    // 1. Resolve plugin order — throws without runtime provider
    const ordered = resolvePluginOrder(this.#plugins);

    // The optional getters (config/logger/metadata/container) and the
    // mandatory runtime are resolved lazily via a Proxy. Runtime is fetched
    // on first access so the runtime-providing plugin (which registers
    // first) can populate CAPABILITIES.RUNTIME before any other plugin
    // touches ctx.runtime. Arrow functions below capture `this` lexically.
    const registry = this.#registry;
    const envSpecs = this.#envSpecs;
    const registrationOwner = (): string | undefined => this.#registeringPlugin;
    // Name of the plugin whose `register()` is currently running — read by
    // `environment.validate` to attribute each env-var declaration. `undefined`
    // outside the registration loop (e.g. a `validate` call from a lifecycle
    // hook), which the fallback message covers.
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
          // Attribute the declaration to the plugin currently registering, so a
          // violation message names the plugin that asked for the variable. One
          // context object is shared by every plugin, so the declaring plugin is
          // read from the registration cursor rather than captured per context.
          envSpecs.push({ name: registrationOwner() ?? 'the application', spec });
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

    // 3. Register each plugin in resolved order, then run the onRegister
    //    hooks it just added — these run "during the owning plugin's
    //    registration" (after that plugin, before the next), distinct from
    //    the onInit hooks that run once all plugins have registered.
    try {
      for (const plugin of ordered) {
        this.#registeringPlugin = plugin.name;
        await plugin.register(ctx);
        await this.#lifecycle.runRegister();
      }
    } finally {
      this.#registeringPlugin = undefined;
    }

    // 4. Validate collected env specs against runtime.env
    const runtime = this.#registry.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    this.#validateEnvironment(runtime);

    // 5. Run init hooks
    await this.#lifecycle.runInit();

    // 5b. Warn about consumed capabilities that no plugin provides. Checked
    //     here — after all plugins have registered and run their init hooks —
    //     so the live registry reflects every capability, including any
    //     registered imperatively rather than declared in `provides`.
    this.#warnUnsatisfiedConsumers();

    // 6. Compile the middleware pipeline
    const chain = this.#pipeline.compile();

    // 6b. Resolve the application's error responder from the pipeline (M70f
    //     re-review, findings 1 & 2). `errorHandler` brands its middleware
    //     function with the responder it built at factory time; the kernel
    //     caches that ONE instance so the pre-pipeline sites — the drain 503,
    //     the malformed-request 400, and the request-lifecycle hooks — can
    //     seed it into their state before they run, where `errorHandler`'s own
    //     `ctx.state` publication cannot reach them. The LAST branded stage
    //     in execution order (the innermost, i.e. the highest priority number
    //     among the selected stages) wins, matching the responder that stage
    //     publishes into `ctx.state` for in-pipeline sites.
    this.#errorResponder = this.#resolveErrorResponder(chain);

    // 7. Run bootstrap hooks
    await this.#lifecycle.runBootstrap();

    // 8. Set the handler (always, so app.fetch works even without listen — CF Workers path)
    if (this.#registry.has(CAPABILITIES.HTTP_ADAPTER)) {
      const adapter = this.#registry.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
      adapter.setHandler((request: IRequest) => this.#handleRequest(request));
    }

    // 9. Listen only if adapter + port are available
    if (options?.port !== undefined) {
      if (!this.#registry.has(CAPABILITIES.HTTP_ADAPTER)) {
        throw new Error(
          `Cannot start HTTP server on port ${options.port}: no 'http-adapter' capability is registered. ` +
            `Register the RuntimePlugin or a custom IHttpAdapter.`,
        );
      }
      const adapter = this.#registry.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
      this.#serverHandle = await adapter.listen(options.port, options.hostname);
    }
  }

  stop(): Promise<void> {
    // No-op if the application never started (e.g. a failed start() or a
    // bare createApplication() used only for inject()). Avoids a confusing
    // "No service registered for capability 'runtime'" from #drainRequests.
    if (!this.#started) {
      return Promise.resolve();
    }
    // Idempotent: a second call — concurrent or later — returns the same
    // shutdown promise instead of re-running the drain and the shutdown/close
    // hooks. Without this, repeated stop() calls fire onShutdown/onClose more
    // than once.
    if (this.#stopPromise !== null) {
      return this.#stopPromise;
    }
    this.#stopPromise = this.#doStop();
    return this.#stopPromise;
  }

  async #doStop(): Promise<void> {
    // Runs FIRST, while the application is still serving normally, so a hook
    // can tell the outside world to stop routing here before that becomes
    // true — deregistering from a service registry, for instance.
    //
    // Guarded rather than awaited unconditionally: `await` on an
    // already-resolved promise still defers everything below by a microtask,
    // which would move when `#stopping` flips and hand a 404 to a request that
    // used to get a 503. With no hook registered the flag is still set in the
    // same synchronous turn as before, so opting out costs nothing.
    //
    // A rejection is CAPTURED rather than allowed to propagate from here.
    // Letting it escape would abort the drain, the socket close, and the
    // shutdown/close hooks, leaving an application that keeps serving — and
    // because `#stopPromise` caches the result, one that can never be stopped
    // at all. The error is still surfaced to the caller, but only after the
    // shutdown it must not prevent has finished.
    let stoppingError: { readonly cause: unknown } | null = null;
    if (this.#lifecycle.hasStopping()) {
      try {
        await this.#lifecycle.runStopping();
      } catch (error) {
        stoppingError = { cause: error };
      }
    }

    // Set before the next await so a request arriving during the drain window
    // sees the shutting-down state and gets a 503.
    this.#stopping = true;

    // Wait for in-flight requests to drain (max 10s). A successfully-started
    // application always has a runtime registered (start() requires a runtime
    // provider) and stop() short-circuits before this when never started, so
    // the runtime is always available here.
    await this.#drainRequests();

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

    // Surfaced last: the application is fully stopped by now, so the caller
    // learns the stopping hook failed without that failure having blocked the
    // shutdown.
    if (stoppingError !== null) {
      throw stoppingError.cause;
    }
  }

  /** Delegates a web-standard Request to the registered IHttpAdapter. */
  // Declared `async` so the no-adapter case REJECTS rather than throwing
  // synchronously: this method returns a promise, and a sync throw escapes a
  // caller's `.catch(…)` — including the `export default { fetch: app.fetch }`
  // Workers entry point, where it would surface as an unhandled exception
  // instead of a failed request.
  async fetch(request: Request): Promise<Response> {
    if (!this.#registry.has(CAPABILITIES.HTTP_ADAPTER)) {
      throw new Error(
        'No HTTP adapter registered. Call register(RuntimePlugin) or provide a custom IHttpAdapter.',
      );
    }
    const adapter = this.#registry.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
    return await adapter.fetch(request);
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

    // Normalize relative paths to a full URL so createRequestContext can parse
    // query params without throwing.  Only normalize paths starting with `/` —
    // arbitrary strings like `'not-a-valid-url'` should still reach
    // createRequestContext so its URL-parse failure is surfaced as a 400.
    const fullUrl = request.url.startsWith('/') ? `http://localhost${request.url}` : request.url;

    // An HTTP adapter attaches the undisturbed web `Request` as `IRequest.raw`,
    // and the terminal handler reads it to decide a WebSocket upgrade or gRPC
    // dispatch. Omitting it here would make `inject()` structurally unable to
    // reach either path — the request would silently fall through to the 404
    // and a test could never tell the difference.
    //
    // Built defensively: a malformed URL must still reach
    // `createRequestContext`, whose parse failure is surfaced as a 400, rather
    // than throwing out of `inject()` here.
    let raw: Request | undefined;
    try {
      raw = new Request(fullUrl, {
        method: request.method,
        headers,
        ...(bodyStr !== undefined && request.method !== 'GET' && request.method !== 'HEAD'
          ? { body: bodyStr }
          : {}),
      });
    } catch {
      raw = undefined;
    }

    const syntheticRequest: IRequest = {
      method: request.method as IRequest['method'],
      url: fullUrl,
      get path() {
        return new URL(fullUrl).pathname;
      },
      headers,
      ...(raw !== undefined ? { raw } : {}),
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

    // A streaming response cannot be presented as a `string` body without
    // draining the live stream, which would consume it. Say so explicitly
    // rather than reporting `body: null`, which reads as "empty response".
    if (snapshot.streaming) {
      throw new Error(
        'inject() cannot read a streaming response body. Call app.fetch() with a web Request ' +
          'and read the returned Response body stream instead.',
      );
    }

    // Decode a byte body (from `response.send(bytes)`) rather than dropping it:
    // reporting `null` made a non-empty response look empty, and made `json()`
    // throw "No JSON body available" for a perfectly valid JSON payload sent
    // as bytes.
    const body = snapshot.body === null
      ? null
      : typeof snapshot.body === 'string'
      ? snapshot.body
      : new TextDecoder().decode(snapshot.body);

    return {
      statusCode: snapshot.status,
      headers: snapshot.headers,
      body,
      json<T>(): T {
        if (body === null) {
          throw new Error('No JSON body available');
        }
        return JSON.parse(body);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  async #handleRequest(request: IRequest): Promise<ResponseBuilder> {
    if (this.#stopping) {
      const builder = new ResponseBuilder();
      // Pre-pipeline: no request context exists yet, so the responder (if any)
      // is seeded from the startup cache — the same instance `errorHandler`
      // would publish into `ctx.state` inside the pipeline — into the fresh
      // state map (M70f re-review, finding 1). With no `errorHandler` the
      // cache is empty and the framework-default shape is written. The status
      // is still written here, so metrics keep seeing 503.
      const state = new Map<string, unknown>();
      if (this.#errorResponder !== undefined) {
        state.set(ERROR_RESPONDER_STATE_KEY, this.#errorResponder);
      }
      respondWithError(
        { state, response: builder, ...this.#safeRequestTarget(request) },
        { status: 503, title: 'Service Unavailable' },
      );
      return builder;
    }

    const runtime = this.#registry.get<IRuntimeServices>(CAPABILITIES.RUNTIME);

    // Build the per-request context and validate the request path BEFORE
    // entering in-flight accounting. Two client errors are caught here:
    //   1. A malformed request URL makes `new URL()` throw inside
    //      createRequestContext.
    //   2. A malformed percent-escape in the path (e.g. `%zz`) would
    //      otherwise surface as a 500 from the router's decodeURIComponent.
    // Both are rejected as a 400. Because #inFlight is incremented only
    // AFTER this succeeds, a rejected request can never leak the counter and
    // stall shutdown drain (the throw would otherwise escape the finally).
    let handle: RequestContextHandle;
    try {
      handle = createRequestContext(request, this.#registry, runtime);
    } catch {
      return this.#badRequest(request);
    }
    if (!isPathDecodable(handle.ctx.request.path)) {
      return this.#badRequest(request);
    }
    const ctx = handle.ctx;

    // Seed the application's resolved error responder into the fresh context
    // BEFORE the request-lifecycle hooks run (M70f re-review, finding 2). The
    // hooks execute before the middleware pipeline, so `errorHandler`'s own
    // `ctx.state` publication has not happened yet: without this seed, a
    // throwing `onRequest` hook would fall through to the no-handler fallback
    // even when an `errorHandler` is registered. `errorHandler` re-publishes
    // the SAME instance inside the pipeline, so the per-request set is
    // idempotent and in-pipeline sites are unaffected.
    if (this.#errorResponder !== undefined) {
      ctx.state.set(ERROR_RESPONDER_STATE_KEY, this.#errorResponder);
    }

    this.#inFlight++;
    try {
      // Run onRequest hooks
      for (const hook of this.#lifecycle.getRequestHooks()) {
        await hook(ctx);
      }

      // Execute pipeline with route dispatch as terminal.
      // Note: Router.match() is backed by Hono's LinearRouter (M22) — it
      // delegates to Hono for route matching and param extraction, then
      // applies the kernel's own deterministic tie-break for equal-specificity
      // routes (§3.6 of the M22 plan).
      await this.#pipeline.execute(ctx, async () => {
        // Protocol dispatch runs BEFORE route matching, and after the pipeline.
        //
        // "After the pipeline" is the M70a security property: auth, metrics and
        // the shutdown drain apply to an upgrade and to an RPC exactly as they
        // do to a `GET /users`.
        //
        // "Before route matching" is precedence, and it is not optional. A
        // WebSocket upgrade is a protocol switch rather than an HTTP route, and
        // a path inside the gRPC `basePath` belongs to gRPC (M49). Deciding
        // these only when nothing matched lets ANY catch-all shadow both — and
        // `react-router-plugin` mounts exactly that, on all seven verbs, for
        // SSR: a full-stack application would answer a WebSocket client with an
        // HTML page and a gRPC client with the same. Both helpers decline
        // cheaply when their capability is absent or does not claim the
        // request, so ordinary traffic reaches the router unchanged.
        if (await this.#tryUpgrade(ctx)) {
          return;
        }

        if (await this.#tryGrpc(ctx)) {
          return;
        }

        const url = new URL(request.url);
        const routeResult = this.#router.match(request.method, url.pathname);

        if (routeResult === null) {
          respondWithError(ctx, { status: 404, title: 'Not Found' });
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
      // Run onError hooks. A hook that throws must not stop the remaining
      // hooks from running, but its failure must not vanish either: an
      // audit logger, telemetry collector, or transaction-rollback hook
      // that fails silently leaves security infrastructure blind. Surface
      // the suppressed error through the sanctioned logger channel.
      const err = error instanceof Error ? error : new Error(String(error));
      for (const hook of this.#lifecycle.getErrorHooks()) {
        try {
          await hook(err, ctx);
        } catch (hookError) {
          this.#reportSuppressedHookError(hookError);
        }
      }

      // X11-2: the unhandled error is visible to the operator. The body stays
      // opaque — the message is not disclosed to the client (M70b's
      // `maskInternalErrors` decision applied consistently); only the log
      // carries it.
      this.#reportUnhandledError(err, ctx);
      respondWithError(ctx, { status: 500, title: 'Internal Server Error' });
      return ctx.response as ResponseBuilder;
    } finally {
      this.#inFlight--;
    }
  }

  /**
   * Tries a WebSocket upgrade when no route matched and the request carries a
   * raw `Request`. Consults the `IWebSocketService`'s upgrade router; when it
   * accepts, brands the `IRequest` with the intent so the HTTP adapter can
   * perform the handshake after the framework handler returns.
   *
   * The brand goes on the `IRequest`, not `ctx.state`, because the adapter
   * holds the former and never sees the context — see {@linkcode
   * UPGRADE_INTENT}.
   *
   * @param ctx - The live request context
   * @returns `true` when this handler answered (intent recorded, or refused)
   */
  async #tryUpgrade(ctx: IRequestContext): Promise<boolean> {
    const raw = ctx.raw;
    // A custom adapter may omit `raw`; treat that as "no upgrade" and fall
    // through to the 404 rather than throwing.
    if (raw === undefined) {
      return false;
    }

    // Resolved optionally — absent the capability, nothing changes. Probed with
    // `has` rather than a try/catch around `get`, because this now runs on
    // EVERY request rather than only on an unmatched one, and throw-driven
    // control flow on the hot path is what AI_GUIDELINES §14 exists to stop.
    if (!this.#registry.has(CAPABILITIES.WEBSOCKET)) {
      return false;
    }
    const wsService = this.#registry.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    if (wsService.routeUpgrade === undefined) {
      return false;
    }

    // Upgrade detection is the ROUTER's job, not the kernel's — it returns
    // `null` for anything that is not an upgrade on a route it owns. Doing the
    // header check here as well would duplicate the rule (§11.1) and, worse,
    // would move a throwing header read outside the service's own reporting
    // wrapper, so a routing failure would be logged nowhere.
    //
    // This backstop is for a third-party service that does not report: before
    // M70a the adapter-side `UpgradeRouterStore` caught here, and letting a
    // routing bug escape into the generic 500 would lose the distinction
    // between "routing failed" and "the handler threw".
    let decision: WebSocketUpgradeDecision | null;
    try {
      decision = await wsService.routeUpgrade(raw);
    } catch (cause) {
      // Reported, not swallowed. The pre-M70a backstop in the adapter's
      // `UpgradeRouterStore` discarded the cause because the adapter holds no
      // logger; the kernel does, so silence here would be a choice rather than
      // a constraint.
      this.#reportUpgradeRouterFailure(cause);
      respondWithError(ctx, { status: 500, title: 'Internal Server Error' });
      return true;
    }

    if (decision === null) {
      return false;
    }

    if (!decision.accept) {
      respondWithError(ctx, { status: decision.status, title: 'Upgrade rejected' });
      return true;
    }

    // RFC 6455 §4.1 forbids a body on the handshake, and the framework mapping
    // has already disturbed it via `arrayBuffer()`. Refusing here makes the
    // behaviour one thing on all four adapters rather than a runtime-specific
    // failure inside the upgrade call. Read from the MAPPED body rather than
    // `content-length`, which is absent both on an in-process `Request` and on
    // any chunked upload.
    if ((await ctx.request.bytes()).length > 0) {
      // The router already accepted, so it may be holding a reserved
      // connection slot for this socket. RFC 6455 close code 1006 (abnormal
      // closure) is the honest signal that no connection was ever established.
      decision.sink.onClose({ code: 1006, reason: 'Upgrade request carried a body' });
      respondWithError(ctx, { status: 400, title: 'Bad Request' });
      return true;
    }

    setUpgradeIntent(ctx.request, {
      sink: decision.sink,
      ...(decision.protocol !== undefined ? { protocol: decision.protocol } : {}),
    });
    return true;
  }

  /**
   * Tries gRPC dispatch when no route matched. Resolves `IGrpcService` from
   * the registry, asks whether it claims the path, and dispatches with a
   * reconstructed web `Request`.
   *
   * @param ctx - The live request context
   * @returns `true` when gRPC answered (handler should return)
   */
  async #tryGrpc(ctx: IRequestContext): Promise<boolean> {
    const raw = ctx.raw;
    if (raw === undefined) {
      return false;
    }

    // Resolved optionally — absent the capability, nothing changes. `has`
    // rather than a try/catch around `get`, for the reason given in
    // `#tryUpgrade`.
    if (!this.#registry.has(CAPABILITIES.GRPC)) {
      return false;
    }
    const grpcService = this.#registry.get<IGrpcService>(CAPABILITIES.GRPC);

    if (!grpcService.available) {
      return false;
    }

    // Prefix guard, BEFORE dispatch. `handleRequest` returns `Promise<Response>`
    // and never `null`, so without this every unmatched route in the
    // application would be answered by gRPC's plain-text 404 instead of the
    // kernel's own JSON one. An implementor that predates `claims` claims
    // nothing, which is the safe default.
    if (grpcService.claims === undefined || !grpcService.claims(raw)) {
      return false;
    }

    // Reconstruct a web Request from the mapped IRequest: the original body is
    // already consumed by `mapWebRequestToFrameworkRequest`. Cloning before the
    // mapping would tax every request in the application to serve the gRPC
    // minority. Trailers do not survive the round trip — M49 records that
    // native gRPC-binary trailers work on no runtime this plugin runs on.
    const bodyBytes = await ctx.request.bytes();
    const grpcRequest = new Request(ctx.request.url, {
      method: ctx.request.method,
      headers: ctx.request.headers,
      // A `Uint8Array` is a valid `BodyInit`, but its backing `ArrayBufferLike`
      // is not narrowed to `ArrayBuffer` under this compiler configuration.
      ...(bodyBytes.length > 0 ? { body: bodyBytes as unknown as BodyInit } : {}),
    });

    const response = await grpcService.handleRequest(grpcRequest);

    // Map the gRPC Response to the framework response
    const snapshot = await response.arrayBuffer();
    const headers = new Headers();
    for (const [key, value] of response.headers.entries()) {
      headers.append(key, value);
    }

    const builder = ctx.response as ResponseBuilder;
    builder.status(response.status);
    for (const [key, value] of headers.entries()) {
      builder.header(key, value);
    }
    builder.send(new Uint8Array(snapshot));
    return true;
  }

  /**
   * Reads the application's resolved error responder off the compiled pipeline
   * (M70f re-review, findings 1 & 2).
   *
   * `errorHandler` brands its middleware function with the responder it built
   * at factory time (see `brandErrorResponder` in `@setu-ts/common`). The
   * kernel caches that instance at startup so the pre-pipeline sites — which
   * run before the pipeline and cannot read `ctx.state` — can seed it into
   * their state. The LAST branded stage in execution order (the innermost,
   * i.e. the highest priority number among the selected stages) wins,
   * because that is the stage whose `ctx.state` publication an in-pipeline
   * site would see last. `undefined`
   * when no `errorHandler` is registered, in which case every site keeps the
   * byte-identical no-handler fallback.
   *
   * @param chain - The compiled middleware chain, in execution order
   */
  #resolveErrorResponder(chain: readonly unknown[]): IErrorResponder | undefined {
    let responder: IErrorResponder | undefined;
    for (const stage of chain) {
      // Every compiled stage is a middleware function; `errorResponderOf`
      // reads a brand off it, so narrow `unknown` to `object` first.
      if (typeof stage !== 'function') {
        continue;
      }
      const branded = errorResponderOf(stage);
      if (branded !== undefined) {
        responder = branded;
      }
    }
    return responder;
  }

  /**
   * Builds a bare `400 Bad Request` response for a client error detected
   * before request processing begins (a malformed request URL or a
   * malformed percent-escape in the path). Kept as a helper so both
   * rejection sites in {@linkcode Application.#handleRequest} produce an
   * identical body.
   *
   * Pre-pipeline: no request context exists yet, so the responder is seeded
   * from the startup cache ({@linkcode Application.#errorResponder}) into the
   * fresh state map — the same responder `errorHandler` would publish into
   * `ctx.state` were this site inside the pipeline. With no `errorHandler`
   * registered the cache is empty and the framework-default shape is written.
   *
   * The target carries a SAFE request ({@linkcode Application.#safeRequestTarget}),
   * never the raw one: a malformed request URL keeps a throwing `path` getter
   * on the synthetic `IRequest`, and a Problem Details formatter that reads
   * `ctx.request.path` for the `instance` member would throw the URL parser
   * error again inside the responder — turning the configured 400 back into an
   * unhandled `TypeError: Invalid URL` (M70f re-review round 2, finding 1).
   */
  #badRequest(request: IRequest): ResponseBuilder {
    const builder = new ResponseBuilder();
    const state = new Map<string, unknown>();
    if (this.#errorResponder !== undefined) {
      state.set(ERROR_RESPONDER_STATE_KEY, this.#errorResponder);
    }
    respondWithError(
      { state, response: builder, ...this.#safeRequestTarget(request) },
      { status: 400, title: 'Bad Request' },
    );
    return builder;
  }

  /**
   * Builds the `request` member of a pre-pipeline {@linkcode respondWithError}
   * target from a request whose path may be unreadable.
   *
   * A formatted error response needs the request path for the Problem Details
   * `instance` member, and the target's `request` field is typed to supply it.
   * But a request that failed URL parsing carries a `path` getter that throws
   * (the synthetic `IRequest` in {@linkcode Application.inject} and the
   * adapter-mapped requests both derive `path` from `new URL(...)`), so handing
   * the raw request to the responder would make the formatter re-throw inside
   * the very response that is supposed to report the failure.
   *
   * The safe target therefore carries the path only when it can be read
   * without throwing — captured once, up front — and omits the `request` field
   * entirely otherwise, which is the documented shape of
   * {@linkcode ErrorResponderTarget.request} ("when one exists"). A formatter
   * that receives no request answers without an `instance` member, which is
   * the correct RFC 9457 outcome for a request whose path cannot be known.
   *
   * @param request - The request that failed pre-pipeline validation
   * @returns `{ request: { path } }` when the path is readable, `{}` when it is not
   */
  #safeRequestTarget(request: IRequest): { request?: { readonly path: string } } {
    let path: string | undefined;
    try {
      path = request.path;
    } catch {
      path = undefined;
    }
    return path === undefined ? {} : { request: { path } };
  }

  /**
   * Surfaces an exception thrown by an `IWebSocketService`'s upgrade router.
   *
   * The framework's own service reports its failures at their source, where it
   * has route context to add; this covers a third-party service that does not.
   * Guarded exactly like {@linkcode Application.#reportSuppressedHookError}: a
   * missing or itself-broken logger must not turn a refused upgrade into a
   * crashed request.
   *
   * @param cause - Whatever the router threw
   */
  #reportUpgradeRouterFailure(cause: unknown): void {
    try {
      if (!this.#registry.has(CAPABILITIES.LOGGER)) {
        return;
      }
      const logger = this.#registry.get<ILogger>(CAPABILITIES.LOGGER);
      const err = cause instanceof Error ? cause : new Error(String(cause));
      logger.error('WebSocket upgrade router threw and was refused', {
        error: err.message,
        stack: err.stack,
      });
    } catch {
      // No safe channel remains — see #reportSuppressedHookError.
    }
  }

  /**
   * Surfaces an exception thrown by an `onError` hook. The failure is
   * reported through {@linkcode CAPABILITIES.LOGGER} when a logger is
   * registered — the sanctioned framework logging channel (AI_GUIDELINES
   * §11.6 forbids `console` here). The whole method is guarded so a missing
   * or itself-broken logger can never propagate out of request handling: in
   * that doubly-degraded case there is no safe channel left and the error is
   * dropped rather than crashing the request.
   */
  #reportSuppressedHookError(hookError: unknown): void {
    try {
      if (!this.#registry.has(CAPABILITIES.LOGGER)) {
        return;
      }
      const logger = this.#registry.get<ILogger>(CAPABILITIES.LOGGER);
      const err = hookError instanceof Error ? hookError : new Error(String(hookError));
      logger.error('onError hook threw and was suppressed', {
        error: err.message,
        stack: err.stack,
      });
    } catch {
      // The logger itself failed or none is resolvable — no safe channel
      // remains without violating the no-console rule; degrade silently.
    }
  }

  /**
   * Surfaces an unhandled request error through the sanctioned logger channel
   * (X11-2). The response body stays opaque — the message is not disclosed to
   * the client (M70b's `maskInternalErrors` decision applied consistently) —
   * but the operator sees the message and stack, with the request identified.
   *
   * Guarded exactly like {@linkcode Application.#reportSuppressedHookError}: a
   * missing or itself-broken logger must not turn an already-failing request
   * into a crashed one.
   *
   * @param error - The unhandled error
   * @param ctx - The request context it occurred in
   */
  #reportUnhandledError(error: Error, ctx: IRequestContext): void {
    try {
      if (!this.#registry.has(CAPABILITIES.LOGGER)) {
        return;
      }
      const logger = this.#registry.get<ILogger>(CAPABILITIES.LOGGER);
      logger.error('Unhandled request error', {
        ...serializeError(error),
        requestId: ctx.id,
        method: ctx.request.method,
        path: ctx.request.path,
      });
    } catch {
      // The logger itself failed or none is resolvable — no safe channel
      // remains without violating the no-console rule; degrade silently.
    }
  }

  /**
   * Emits a soft `warn`-level diagnostic for each capability a plugin declares
   * in `consumes` that no registered plugin provides. Unlike a missing
   * `dependencies` entry (which fails plugin resolution), an unsatisfied
   * `consumes` does not stop startup — the plugin resolves the capability
   * lazily at request time — but the deferred `services.get` would then throw
   * per request, so surfacing it once at startup, naming the consumer, is the
   * friendlier failure mode.
   *
   * Reported through {@linkcode CAPABILITIES.LOGGER} when a logger is
   * registered — the sanctioned framework logging channel (AI_GUIDELINES §11.6
   * forbids `console` here). The emission is guarded so a missing or
   * itself-broken logger degrades silently rather than turning an advisory
   * warning into a startup failure.
   */
  #warnUnsatisfiedConsumers(): void {
    const unsatisfied = findUnsatisfiedConsumers(
      this.#plugins,
      (token) => this.#registry.has(token),
    );
    if (unsatisfied.length === 0) {
      return;
    }
    try {
      if (!this.#registry.has(CAPABILITIES.LOGGER)) {
        return;
      }
      const logger = this.#registry.get<ILogger>(CAPABILITIES.LOGGER);
      for (const { plugin, capability } of unsatisfied) {
        logger.warn(
          `Plugin '${plugin}' consumes capability '${capability}', but no registered plugin provides it. ` +
            `Calls to services.get('${capability}') will fail at runtime — register a plugin that provides it.`,
          { plugin, capability },
        );
      }
    } catch {
      // The logger itself failed or none is resolvable — no safe channel
      // remains without violating the no-console rule; degrade silently.
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
    // Monotonic clock: this is a duration budget, so it must not be measured
    // with `now()` (wall clock), which an NTP step can move backwards — cutting
    // the drain short or extending it past the intended 10s.
    const deadline = runtime.hrtime() + 10_000;
    // Iteration cap: a manual test clock that never advances would otherwise
    // spin forever (the deadline never arrives). 200 polls × 50ms ≈ 10s of
    // real polling under a normal clock, and a hard ceiling regardless.
    let polls = 0;
    const MAX_POLLS = 200;

    while (this.#inFlight > 0 && runtime.hrtime() < deadline && polls < MAX_POLLS) {
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
 * import { createApplication } from '@setu-ts/kernel';
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
