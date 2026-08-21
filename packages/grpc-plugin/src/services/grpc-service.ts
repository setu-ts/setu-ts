/**
 * {@linkcode GrpcService} — the {@linkcode IGrpcService} implementation
 * registered under `CAPABILITIES.GRPC`.
 *
 * It owns the registered service list, builds the Connect router lazily (so
 * services added after `register()` are picked up), and dispatches RPC traffic.
 *
 * @module
 */

import type {
  GrpcServiceDefinition,
  IGrpcService,
  IHealthService,
  ILogger,
  RpcFetchHandler,
  ServiceImpl,
} from '@setu-ts/common';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { GrpcPluginOptions } from '../interfaces/index.ts';
import {
  dispatchRequest,
  isWithinBasePath,
  normalizeBasePath,
} from '../transports/rpc-dispatcher.ts';
import { buildConnectRouter, type ServiceEntry } from '../transports/connect-router-builder.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Constructor inputs for {@linkcode GrpcService}. */
export interface GrpcServiceOptions {
  readonly connectRuntime: ConnectRuntime;
  readonly embeddedDescriptors: EmbeddedDescriptors;
  readonly options: GrpcPluginOptions;
  readonly healthService: IHealthService | undefined;
  /**
   * Resolves the logger at RPC-call time (M52b: read per call, not captured at
   * `register()`). Returns `undefined` when no logger is registered. Used to
   * log handler failures (X7-5).
   */
  readonly resolveLogger?: () => ILogger | undefined;
}

/**
 * The gRPC service applications use to register Connect/gRPC services.
 *
 * @example
 * ```typescript
 * const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
 * grpc.addService(EchoService, { echo: (req) => ({ text: req.text }) });
 * ```
 */
export class GrpcService implements IGrpcService {
  readonly #services: ServiceEntry[] = [];
  readonly #basePath: string;
  readonly #connectRuntime: ConnectRuntime;
  readonly #embeddedDescriptors: EmbeddedDescriptors;
  readonly #options: GrpcPluginOptions;
  readonly #healthService: IHealthService | undefined;
  readonly #resolveLogger: (() => ILogger | undefined) | undefined;

  #dispatchMap: Map<string, (request: Request) => Promise<Response>> | null = null;
  #closed = false;
  /**
   * Procedure paths the router served before shutdown. Retained so a drained
   * server can answer `503` for its OWN procedures without claiming ordinary
   * application routes, which must keep working while the app drains.
   */
  #servedPaths: ReadonlySet<string> = new Set();

  /**
   * Whether gRPC dispatch is available. Always `true` since the kernel now
   * resolves `IGrpcService` from the service registry and dispatches after
   * the middleware pipeline (M70a). The previous adapter-based seam is retired.
   */
  readonly available = true;

  constructor(init: GrpcServiceOptions) {
    this.#connectRuntime = init.connectRuntime;
    this.#embeddedDescriptors = init.embeddedDescriptors;
    this.#options = init.options;
    this.#healthService = init.healthService;
    this.#resolveLogger = init.resolveLogger;
    this.#basePath = normalizeBasePath(init.options.basePath ?? '/grpc');

    for (const entry of init.options.services ?? []) {
      this.addService(
        entry.definition as GrpcServiceDefinition,
        entry.implementation as Partial<ServiceImpl> | undefined,
      );
    }
  }

  /** Number of application services registered. Read by the health indicator. */
  get serviceCount(): number {
    return this.#services.length;
  }

  addService<TDef extends GrpcServiceDefinition>(
    definition: TDef,
    implementation?: Partial<ServiceImpl>,
  ): void {
    const { typeName } = definition;
    if (this.#services.some((s) => (s.definition as GrpcServiceDefinition).typeName === typeName)) {
      throw new Error(`Service '${typeName}' has already been registered`);
    }
    this.#services.push({ definition, implementation });
    // Invalidate the built router so the new service is picked up.
    this.#dispatchMap = null;
  }

  /**
   * Whether this service claims the request's path — that is, whether the path
   * lies inside the configured `basePath`.
   *
   * The kernel calls this before {@linkcode GrpcService.handleRequest}, which
   * answers `404` for a claimed path with no matching procedure and therefore
   * cannot itself be used to tell "not mine" from "mine, but unknown". Without
   * this guard every unmatched route in the application would be answered by
   * gRPC's plain-text `404` instead of the kernel's JSON one.
   *
   * A **root** `basePath` is the exception, and it is load-bearing: `''`
   * contains every path, so a prefix test would claim the entire application.
   * The kernel consults `claims` before route matching, so that would 404 every
   * ordinary route. At the root this therefore claims only paths it can
   * actually serve, mirroring the asymmetry `dispatchRequest` already
   * documents — "not a known procedure" and "an ordinary application route"
   * are indistinguishable there, so both fall through.
   *
   * Inside a non-root base path the prefix IS the claim, so an unknown
   * procedure under `/grpc` answers gRPC's `404` rather than falling through to
   * the application — the M49 behaviour.
   *
   * @param request - The native fetch request
   * @returns `true` when this service will serve the request
   * @since 0.3.0
   */
  claims(request: Request): boolean {
    const path = new URL(request.url).pathname;
    if (!isWithinBasePath(path, this.#basePath)) {
      return false;
    }
    if (this.#basePath !== '') {
      return true;
    }
    // Mounted at the root. After `close()` the router is gone and only the
    // paths this server actually served may still be claimed — for their 503.
    if (this.#closed) {
      return this.#servedPaths.has(path);
    }
    return this.#buildDispatchMap().has(path);
  }

  /**
   * Handles an RPC request directly.
   *
   * Returns a 404 response when the request does not match any registered
   * service path. Callers routing traffic should consult
   * {@linkcode GrpcService.claims} first.
   */
  handleRequest(request: Request): Promise<Response> {
    return Promise.resolve(this.#dispatch(request)).then(
      (response) => response ?? new Response('Not Found', { status: 404 }),
    );
  }

  /**
   * The handler that used to be installed into `IHttpAdapter.setRpcHandler`.
   * Returns `null` for any request outside `basePath`.
   *
   * @deprecated Since M70a the kernel dispatches gRPC itself, after the
   * middleware pipeline, so nothing installs this handler — the pre-pipeline
   * interceptor was the security defect that change closed. Use
   * {@linkcode GrpcService.claims} together with
   * {@linkcode GrpcService.handleRequest} instead. Retained because
   * {@linkcode GrpcService} is published surface (AI_GUIDELINES §9.2).
   */
  createFetchHandler(): RpcFetchHandler {
    return (request: Request): Promise<Response | null> => Promise.resolve(this.#dispatch(request));
  }

  /**
   * Releases the built router and its handlers. Afterwards the plugin's own
   * procedures answer `503` instead of rebuilding a router for an application
   * that is shutting down, while every other path falls through untouched.
   */
  close(): void {
    if (this.#closed) {
      // Idempotent: a second call must not wipe the served-path set captured by
      // the first, which would silently turn every 503 into a fall-through.
      return;
    }
    this.#closed = true;
    this.#servedPaths = new Set(this.#dispatchMap?.keys() ?? []);
    this.#dispatchMap = null;
  }

  /**
   * The lazily-built router, shared by {@linkcode GrpcService.claims} and
   * `#dispatch` so the two can never disagree about which paths are served.
   * Built on demand because `addService` may be called after `register()`, and
   * cached until the next `addService` invalidates it.
   */
  #buildDispatchMap(): Map<string, (request: Request) => Promise<Response>> {
    this.#dispatchMap ??= buildConnectRouter({
      connectRuntime: this.#connectRuntime,
      basePath: this.#basePath,
      reflection: this.#options.reflection ?? true,
      health: this.#options.health ?? true,
      services: this.#services,
      embeddedDescriptors: this.#embeddedDescriptors,
      healthService: this.#healthService,
      resolveLogger: this.#resolveLogger,
      interceptors: this.#options.interceptors,
    }).dispatchMap;
    return this.#dispatchMap;
  }

  /** Resolves a request against the dispatch map, building the router on demand. */
  #dispatch(request: Request): Response | Promise<Response | null> | null {
    if (this.#closed) {
      // Claim only paths this server actually served; ordinary application
      // routes must keep answering while the app drains.
      const path = new URL(request.url).pathname;
      return this.#servedPaths.has(path)
        ? new Response('Service Unavailable', { status: 503 })
        : null;
    }
    return dispatchRequest(request, this.#buildDispatchMap(), this.#basePath);
  }
}
