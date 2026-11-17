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
 * Retained only for the deprecated {@linkcode IHttpAdapter.setRpcHandler}
 * seam, which no adapter consults. Since M70a gRPC is dispatched from the
 * kernel's terminal handler, after the middleware pipeline has run and before
 * route matching: the kernel resolves {@linkcode IGrpcService}, asks
 * `claims()` whether the path belongs to gRPC, and calls `handleRequest`
 * directly with a `Request` rebuilt from the already-mapped body.
 *
 * Historically the adapter consulted a handler of this shape **before** mapping
 * the request, which is why the contract required one returning `null` to leave
 * the body unread. Nothing calls it on that path any more.
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
 * What the connection an RPC arrived on can carry, as the kernel tells
 * {@linkcode IGrpcService.refuses} and {@linkcode IGrpcService.handleRpc}.
 * @since 0.13.0
 */
export interface RpcTransport {
  /**
   * Whether HTTP trailers on the response reach the client. Native
   * `application/grpc` reports its status in trailers, so it can be served
   * only when this is `true`.
   */
  readonly trailers: boolean;

  /**
   * Aborts when the client goes away: the raw request's `signal`. A service
   * uses it as the call's cancellation signal in place of the dispatched
   * request's own, which the kernel leaves unset — following a signal from a
   * freshly built `Request` costs about 8% of unary throughput on Node.
   * Absent: the dispatched request's own signal applies.
   */
  readonly signal?: AbortSignal;
}

/**
 * An RPC as the kernel hands it to {@linkcode IGrpcService.handleRpc}: plain
 * fields rather than a fetch `Request`, which costs a copy of every header and
 * a body stream per call to build (M139b).
 * @since 0.13.0
 */
export interface RpcCall {
  /** The request method. */
  readonly method: string;
  /** The absolute request URL. */
  readonly url: string;
  /** The request path, without the query string. */
  readonly path: string;
  /** The request headers, including any a middleware set. */
  readonly headers: Headers;
  /**
   * The whole request body, or — for a client-streaming or bidirectional
   * procedure whose body nothing in the pipeline read — the unread body
   * stream (see {@linkcode IGrpcService.streamsRequest}).
   */
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
}

/**
 * An RPC reply as {@linkcode IGrpcService.handleRpc} returns it.
 * @since 0.13.0
 */
export interface RpcReply {
  /** The HTTP status. */
  readonly status: number;
  /** The response headers. A repeated header keeps every value. */
  readonly headers: Headers;
  /**
   * The body: the whole of it for a single response message (a unary or
   * client-streaming procedure), a stream for a reply written as it is
   * produced (server-streaming or bidirectional), or `null` for none. The
   * kernel writes a stream as a stream and anything else whole.
   */
  readonly body: Uint8Array | ReadableStream<Uint8Array> | null;
  /**
   * Trailers to send after the body, resolving once it ends. Set only when the
   * transport reported `trailers: true`. A reply with trailers is always
   * streamed.
   */
  readonly trailers?: Promise<Headers>;
}

/**
 * How a gRPC client reaches one target, as {@linkcode IGrpcService.client}
 * takes it (M139b §3.12). Every member is optional; a per-call value overrides
 * the plugin's per-target entry, which overrides the defaults below.
 * @since 0.13.0
 */
export interface GrpcClientOptions {
  /**
   * The path the target serves gRPC under, appended to its origin: `'/grpc'`
   * for a member mounted with `GrpcPlugin({ basePath: '/grpc' })`. Empty or
   * starting with `/`, never ending with one. Default `''`.
   */
  readonly basePath?: string;
  /**
   * The wire protocol. `'connect'` (default) is the cheapest path through a
   * Connect server; `'grpc'` is native gRPC, for a server that is not Connect;
   * `'grpc-web'` for a server behind a gRPC-Web proxy.
   */
  readonly protocol?: 'connect' | 'grpc' | 'grpc-web';
  /**
   * `'2'` (default) multiplexes every call to one origin over one HTTP/2
   * session; `'1.1'` uses HTTP/1.1 connections. Native gRPC needs `'2'`.
   */
  readonly httpVersion?: '2' | '1.1';
  /**
   * The deadline of each call, in milliseconds, unless the call passes its own
   * `timeoutMs`. An integer from 1 to 2147483647. Default `5000`.
   */
  readonly timeoutMs?: number;
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
   * Whether this service refuses the request outright, decided from its
   * HEADERS alone.
   *
   * The kernel calls this immediately after {@linkcode IGrpcService.claims}
   * and **before it reads the request body**. That ordering is the whole
   * point. A native `application/grpc` request on a connection without
   * trailers is refused whatever its body contains, and buffering first made the refusal unreachable for the case
   * that needs it most: a client-streaming or bidirectional call holds its
   * request stream OPEN, so the body read never resolves and the caller
   * receives no frames at all rather than the refusal (V5-5). `grpcurl` opens
   * a bidirectional reflection stream before anything else, so it hung on
   * every request — which is why the refusal being correct (M70i) and the
   * base path being right (M70i) neither of them helped.
   *
   * Returning a `Response` answers it as-is. Returning `null` means "no
   * header-only decision", and the kernel proceeds to
   * {@linkcode IGrpcService.handleRequest} as before.
   *
   * Optional for source compatibility. An implementor that omits it keeps the
   * previous behaviour exactly, buffering included.
   *
   * @param request - The native fetch request, body untouched
   * @param transport - What the connection can carry, computed by the kernel
   *   from `IRequest.responseTrailers` (since 0.13.0). Absent from a
   *   caller that predates it, which means "no trailers".
   * @returns The refusal to answer with, or `null` to dispatch normally
   * @since 0.6.0
   */
  refuses?(request: Request, transport?: RpcTransport): Response | null;

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
   * Handles an RPC with knowledge of the transport, returning the reply
   * together with what the kernel needs to write it: whether its body is a
   * stream, and the trailers to send after it.
   *
   * The kernel prefers this over {@linkcode IGrpcService.handleRequest} when
   * present. An implementor without it is dispatched through `handleRequest`
   * and its reply is buffered, as before. `handleRequest` should run the same
   * dispatch with `{ trailers: false }`, so the two entry points cannot
   * disagree.
   *
   * @param call - The RPC, built by the kernel from the live request
   * @param transport - What the connection can carry, and the client's signal
   * @returns The reply to write
   * @since 0.13.0
   */
  handleRpc?(call: RpcCall, transport: RpcTransport): Promise<RpcReply>;

  /**
   * Whether the procedure a request names takes a STREAM of request messages
   * (client-streaming or bidirectional), decided from the request line and
   * headers alone.
   *
   * The kernel calls this before reading the body. When it returns `true` and
   * nothing in the pipeline has read the body yet, the kernel hands the
   * unread body stream to the dispatch instead of buffering it, so the call
   * can make progress while the client is still sending. Every other request
   * is buffered as before, under the runtime's `maxBodyBytes`. A streamed body
   * is not bounded by `maxBodyBytes` (a total would end every long-lived
   * stream); the implementor bounds it per message.
   *
   * Optional; absent means "never stream the request".
   *
   * @param request - The native fetch request, body untouched
   * @returns `true` for a client-streaming or bidirectional procedure
   * @since 0.13.0
   */
  streamsRequest?(request: Request): boolean;

  /**
   * A client for a service another process serves (M139b §3.12).
   *
   * `target` is an absolute `http(s)://` URL, or a logical service name
   * resolved through `CAPABILITIES.SERVICE_DISCOVERY` on every call — the
   * client then reports each call's outcome back, so an instance that refuses
   * connections is ejected. Connections are reused per origin and closed with
   * the application. The same `(definition, target, options)` returns the same
   * client, so asking per request costs a lookup.
   *
   * Returns `unknown` because this package names no Connect type; the grpc
   * plugin's `grpcClient()` returns it typed. Optional for implementors written
   * before it existed.
   *
   * @param definition - The service descriptor, as generated by Protobuf-ES
   * @param target - An absolute URL, or a service name known to discovery
   * @param options - Overrides for this client
   * @returns The client
   * @throws {TypeError} When an option is out of range, or `target` is a name
   *   and no service discovery is registered
   * @since 0.13.0
   */
  client?(definition: GrpcServiceDefinition, target: string, options?: GrpcClientOptions): unknown;

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
