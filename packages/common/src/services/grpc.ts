/**
 * gRPC service contracts — the types that enable a Hono application to co-serve
 * gRPC/Connect on the same port as ordinary Hono routes.
 *
 * The adapter seam (see {@linkcode IHttpAdapter.setRpcHandler?}) is consulted
 * before body mapping, allowing a fetch-native Connect handler to return a
 * {@linkcode Response} for RPC traffic or {@linkcode null} to fall through to
 * Hono.
 *
 * @module
 * @since 0.3.0
 */

// Request and Response are web-standard global types (available in Deno, Node, Bun, Workers).
// No import needed from common package.

/**
 * A fetch handler that attempts to handle a gRPC/Connect request.
 * Returns a {@linkcode Response} if the request was handled as RPC,
 * otherwise returns {@linkcode null} so the adapter falls through to normal
 * Hono handling.
 *
 * **A handler that returns `null` MUST leave the request body unread.** The
 * adapter consults this handler before mapping the request, and then maps the
 * same `Request` for the Hono pipeline; a body consumed here cannot be read
 * again, so the fall-through would fail with "Body already consumed". Decide
 * from the method, URL and headers — as the first-party gRPC plugin does, which
 * matches on a path prefix alone. A handler that genuinely must inspect the
 * body first has to read `request.clone()` and leave the original intact.
 *
 * @since 0.3.0
 */
export type RpcFetchHandler = (request: Request) => Promise<Response | null>;

/**
 * A gRPC service definition that satisfies the plugin's expectations.
 * This is a structural constraint satisfied by generated descriptor objects
 * from {@linkcode @bufbuild/protobuf}. It contains only the fields the plugin
 * needs to route requests and build reflection data.
 *
 * @since 0.3.0
 */
export interface GrpcServiceDefinition<TMethod = unknown> {
  /**
   * The fully qualified name of the service, e.g. `"package.ServiceName"`.
   */
  readonly typeName: string;
  /**
   * Methods keyed by their camelCase local name.
   *
   * This is deliberately `method` (singular), matching the record a Protobuf-ES
   * `DescService` exposes alongside its `methods` ARRAY. The array form is not
   * assignable to `Record<string, TMethod>`, so constraining on `methods` would
   * reject every real generated descriptor and force callers into a cast — the
   * opposite of what this structural constraint exists for.
   */
  readonly method: Readonly<Record<string, TMethod>>;
}

/**
 * The serving status returned by the health bridge.
 * These values map onto the gRPC v1 Health response enum.
 *
 * @see {@linkcode grpc.health.v1.Health.ServingStatus}
 * @since 0.3.0
 */
export type GrpcServingStatus = 'unknown' | 'serving' | 'not-serving' | 'service-unknown';

/**
 * A service implementation object as expected by Connect. Each method name
 * maps to a function implementing that procedure. This is a structural type
 * satisfied by generated descriptor objects from {@linkcode @bufbuild/protobuf}.
 *
 * @deprecated Since M70f this type has no reader. It was the parameter type of
 * {@linkcode IGrpcService.addService}'s `implementation`, which is now
 * `unknown`: an index-signature type rejects a **class instance**, whose
 * methods live on the prototype rather than as own properties, and Connect
 * accepts a class instance as an implementation. Nothing in the framework
 * consumes this type any more; it is retained only because removing a
 * published export is a breaking change (AI_GUIDELINES §9.2) and will be
 * dropped in a later release. Pass the implementation directly — no cast and
 * no annotation is needed.
 *
 * @since 0.3.0
 */
export interface ServiceImpl<TMethod = unknown> {
  /** Map of method names to their implementation descriptors. */
  readonly [key: string]: TMethod;
}

/**
 * The service contract that applications use to register gRPC/Connect services.
 * Provided by the `grpc-plugin` under the `CAPABILITIES.GRPC` token.
 *
 * @example
 * ```typescript
 * import { CAPABILITIES } from '@setu-ts/common';
 * import { GrpcService } from '@setu-ts/grpc-plugin';
 *
 * const grpc = ctx.services.get<IGrpcService>(CAPABILITIES.GRPC);
 * grpc.addService(MyService, impl);
 * ```
 *
 * @since 0.3.0
 */
export interface IGrpcService {
  /**
   * Registers a gRPC service definition with an optional implementation.
   *
   * @param definition - The service descriptor (must satisfy {@linkcode GrpcServiceDefinition})
   * @param implementation - Optional service implementation object; if omitted,
   *   the service is registered for reflection only
   * @throws {Error} If a service with the same type name has already been registered
   */
  addService<TDef extends GrpcServiceDefinition>(
    definition: TDef,
    /**
     * Optional service implementation mapping method local-names to handler
     * functions. Typed permissively (`unknown`) because the plugin is generic
     * over the application's generated descriptors and cannot enumerate
     * concrete method signatures, and because Connect accepts both plain
     * objects and class instances — the latter's methods live on the
     * prototype, so an index-signature type would reject a valid implementation.
     */
    implementation?: unknown,
  ): void;

  /**
   * Whether this service claims a request — that is, whether the request path
   * lies inside the configured `basePath`.
   *
   * The kernel terminal handler calls this **before** {@linkcode
   * IGrpcService.handleRequest} so an ordinary unmatched route keeps the
   * kernel's own `404`. That guard cannot be derived from `handleRequest`,
   * which returns `Promise<Response>` and never `null`: a path outside the
   * base path is indistinguishable from a claimed path with no such procedure
   * once both have collapsed into a `404`.
   *
   * Detection is prefix-only and deliberately so — Connect's real unary
   * content types include `application/json`, so media-type sniffing would
   * hijack ordinary application routes.
   *
   * Optional for source compatibility with implementors written before this
   * member existed. The kernel treats an **absent** `claims` as "claims
   * nothing" and falls through to its own `404`, because silently claiming
   * every unmatched route is the more damaging default.
   *
   * @param request - The native fetch request
   * @returns `true` when the request lies inside this service's base path
   * @since 0.3.0
   */
  claims?(request: Request): boolean;

  /**
   * Handles an incoming RPC request directly.
   *
   * Called by the kernel terminal handler after the middleware pipeline has
   * run and {@linkcode IGrpcService.claims} has accepted the path; also usable
   * directly by tests and advanced scenarios.
   *
   * Returns a `404` response for a path this service claims but for which no
   * procedure is registered. It never returns `null`, which is why
   * {@linkcode IGrpcService.claims} exists.
   *
   * @param request - The native fetch request
   * @returns The gRPC/Connect response
   */
  handleRequest(request: Request): Promise<Response>;

  /**
   * Whether gRPC dispatch is available.
   *
   * Before M70a this reported whether the resolved HTTP adapter implemented
   * the `setRpcHandler` seam. The kernel now dispatches gRPC itself, after the
   * middleware pipeline, so no adapter capability is required and the
   * framework's own service reports `true` unconditionally.
   */
  readonly available: boolean;
}
