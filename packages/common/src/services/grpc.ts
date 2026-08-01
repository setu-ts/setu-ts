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
   * Map of method names to their implementation descriptors.
   * The plugin reads this to build the dispatch table and reflection data.
   */
  readonly methods: Readonly<Record<string, TMethod>>;
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
 * import { CAPABILITIES } from '@hono-enterprise/common';
 * import { GrpcService } from '@hono-enterprise/grpc-plugin';
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
     * Optional service implementation object mapping method local-names to
     * handler functions. Typed permissively (methods are `unknown`) because the
     * plugin is generic over the application's generated descriptors and cannot
     * enumerate concrete method signatures.
     */
    implementation?: Partial<ServiceImpl>,
  ): void;

  /**
   * Handles an incoming RPC request directly. Used by internal tests and by
   * advanced scenarios that bypass the adapter seam. Throws
   * {@linkcode GrpcUnavailableError} when the adapter does not support the
   * RPC interceptor widening.
   *
   * @param request - The native fetch request
   * @returns The gRPC/Connect response
   */
  handleRequest(request: Request): Promise<Response>;

  /**
   * Whether the HTTP adapter supports the RPC interceptor seam.
   * This is true when the adapter implements {@linkcode IHttpAdapter.setRpcHandler?}.
   */
  readonly available: boolean;
}
