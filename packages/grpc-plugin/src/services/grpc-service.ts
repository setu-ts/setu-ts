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
  IHttpAdapter,
  RpcFetchHandler,
  ServiceImpl,
} from '@setu-ts/common';
import { GrpcUnavailableError } from '../errors/grpc-errors.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { GrpcPluginOptions } from '../interfaces/index.ts';
import { dispatchRequest, normalizeBasePath } from '../transports/rpc-dispatcher.ts';
import { buildConnectRouter, type ServiceEntry } from '../transports/connect-router-builder.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Constructor inputs for {@linkcode GrpcService}. */
export interface GrpcServiceOptions {
  readonly connectRuntime: ConnectRuntime;
  readonly embeddedDescriptors: EmbeddedDescriptors;
  readonly options: GrpcPluginOptions;
  /** The resolved HTTP adapter; RPC is unavailable when it has no `setRpcHandler`. */
  readonly adapter: IHttpAdapter | undefined;
  readonly healthService: IHealthService | undefined;
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

  #dispatchMap: Map<string, (request: Request) => Promise<Response>> | null = null;
  #closed = false;
  /**
   * Procedure paths the router served before shutdown. Retained so a drained
   * server can answer `503` for its OWN procedures without claiming ordinary
   * application routes, which must keep working while the app drains.
   */
  #servedPaths: ReadonlySet<string> = new Set();

  /** Whether the HTTP adapter supports the RPC interceptor seam. */
  readonly available: boolean;

  constructor(init: GrpcServiceOptions) {
    this.#connectRuntime = init.connectRuntime;
    this.#embeddedDescriptors = init.embeddedDescriptors;
    this.#options = init.options;
    this.#healthService = init.healthService;
    this.#basePath = normalizeBasePath(init.options.basePath ?? '/grpc');
    this.available = typeof init.adapter?.setRpcHandler === 'function';

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
   * Handles an RPC request directly, bypassing the adapter seam.
   *
   * @throws {GrpcUnavailableError} When the adapter does not implement
   *   `setRpcHandler` — a misconfiguration surfaces on use as well as at
   *   startup.
   */
  handleRequest(request: Request): Promise<Response> {
    if (!this.available) {
      return Promise.reject(new GrpcUnavailableError());
    }
    return Promise.resolve(this.#dispatch(request)).then(
      (response) => response ?? new Response('Not Found', { status: 404 }),
    );
  }

  /**
   * The handler installed into `IHttpAdapter.setRpcHandler`. Returns `null` for
   * any request outside `basePath`, so ordinary traffic falls through to Hono
   * untouched.
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
    if (this.#dispatchMap === null) {
      this.#dispatchMap = buildConnectRouter({
        connectRuntime: this.#connectRuntime,
        basePath: this.#basePath,
        reflection: this.#options.reflection ?? true,
        health: this.#options.health ?? true,
        services: this.#services,
        embeddedDescriptors: this.#embeddedDescriptors,
        healthService: this.#healthService,
      }).dispatchMap;
    }
    return dispatchRequest(request, this.#dispatchMap, this.#basePath);
  }
}
