/**
 * HTTP abstractions — request, response, request context, and middleware.
 *
 * These interfaces normalize HTTP handling across runtimes; the runtime
 * plugin's HTTP adapters translate native requests/responses to and from
 * them.
 *
 * @module
 */
import type { HttpMethod } from './types.ts';
import type { IServiceRegistry } from './registry.ts';
import type { IPrincipal } from './services/auth.ts';

/**
 * Opaque marker returned by {@linkcode IResponse} terminal methods and
 * expected back from route handlers. It exists purely so the type system can
 * verify a handler produced a response; only the kernel creates values of
 * this type.
 *
 * @since 0.1.0
 */
export interface HandlerResult {
  /** Brand preventing accidental structural matches. */
  readonly __handlerResult: true;
}

/**
 * Runtime-agnostic view of an incoming HTTP request.
 *
 * @since 0.1.0
 */
export interface IRequest {
  /** The HTTP method. */
  readonly method: HttpMethod;
  /** The full request URL. */
  readonly url: string;
  /** The URL path component (no query string). */
  readonly path: string;
  /** Request headers (web-standard `Headers`). */
  readonly headers: Headers;
  /** Client IP address, when derivable. */
  readonly ip?: string;
  /**
   * The authenticated principal, populated by authentication middleware.
   * Absent when the request is unauthenticated.
   */
  user?: IPrincipal;
  /**
   * An abort signal that fires when the underlying HTTP connection is
   * severed (client disconnect, timeout). Populated by the HTTP adapter
   * from the native `Request.signal`; optional because injected / test
   * requests may not carry one.
   *
   * When absent, {@linkcode createRequestContext} falls back to a
   * non-aborting sentinel so that producers reading
   * {@linkcode IRequestContext.signal} always have a live signal to listen on.
   */
  signal?: AbortSignal;
  /**
   * Reads and parses the body as JSON.
   *
   * @typeParam T - The expected body shape (validate before trusting)
   * @returns The parsed body
   * @throws {SyntaxError} If the body is not valid JSON
   */
  json<T = unknown>(): Promise<T>;
  /**
   * Reads the body as text.
   *
   * @returns The body text
   */
  text(): Promise<string>;
  /**
   * Reads the body as raw bytes.
   *
   * @returns The body bytes
   */
  bytes(): Promise<Uint8Array>;
}

/**
 * Runtime-agnostic response builder. Configuration methods (`status`,
 * `header`) chain; terminal methods (`json`, `text`, `send`, `redirect`)
 * produce the {@linkcode HandlerResult} a route handler returns.
 *
 * @example
 * ```typescript
 * app.router.get('/users/:id', (ctx) => {
 *   return ctx.response.status(200).json({ id: ctx.params.id });
 * });
 * ```
 * @since 0.1.0
 */
export interface IResponse {
  /**
   * Sets the response status code.
   *
   * @param code - HTTP status code
   * @returns This response, for chaining
   */
  status(code: number): IResponse;
  /**
   * Sets a response header.
   *
   * @param name - Header name
   * @param value - Header value
   * @returns This response, for chaining
   */
  header(name: string, value: string): IResponse;
  /**
   * Appends a response header, preserving any existing values for the same
   * name rather than replacing them (unlike {@linkcode IResponse.header},
   * which overwrites). This is the correct way to emit multiple headers of the
   * same name — most notably several `Set-Cookie` headers (e.g. an access
   * cookie plus a refresh cookie, or deleting several cookies at once).
   *
   * @param name - Header name
   * @param value - Header value to add
   * @returns This response, for chaining
   */
  appendHeader(name: string, value: string): IResponse;
  /**
   * Sends a JSON response.
   *
   * @typeParam T - The body type
   * @param body - Value serialized to JSON
   * @returns The handler result
   */
  json<T>(body: T): HandlerResult;
  /**
   * Sends a plain-text response.
   *
   * @param body - The response text
   * @returns The handler result
   */
  text(body: string): HandlerResult;
  /**
   * Sends a raw byte response.
   *
   * @param body - The response bytes; omit for an empty body
   * @returns The handler result
   */
  send(body?: Uint8Array): HandlerResult;
  /**
   * Sends a redirect response.
   *
   * @param url - Redirect target
   * @param status - Redirect status code (defaults to 302)
   * @returns The handler result
   */
  redirect(url: string, status?: number): HandlerResult;
  /**
   * Sends a streaming response body.
   *
   * Accepts a web-standard {@linkcode ReadableStream} so that a handler can flush
   * bytes progressively over a long-lived connection instead of buffering a
   * whole body before send. This is the shared foundation for Server-Sent Events
   * (Milestone 43), React SSR streaming (Milestone 44), large file downloads
   * (storage-plugin, Milestone 28), and export / report responses.
   *
   * Because the runtime maps the response to a web-standard
   * `new Response(streamBody, { status, headers })`, streaming is free on every
   * platform (Node via Hono, Deno, Bun, Cloudflare Workers) with no buffer-then-send.
   *
   * @param body - A `ReadableStream` of `Uint8Array` chunks
   * @returns The handler result
   * @since 0.2.0
   */
  stream(body: ReadableStream<Uint8Array>): HandlerResult;
  /**
   * Returns an immutable snapshot of the current response state (status,
   * headers, body). Enables middleware to inspect the response after
   * `next()` returns — required for transparent response caching.
   *
   * Returns a **discriminated union** keyed on `streaming`: when `false`,
   * `body` is `Uint8Array | string | null` (buffered); when `true`,
   * `body` is a `ReadableStream<Uint8Array>` (live stream). Middleware that
   * reads the body (e.g. cache middleware) must check `streaming` first to
   * avoid draining a live stream.
   *
   * @returns The status code, headers, and either a buffered body or a live stream
   * @since 0.1.0
   */
  snapshot(): ResponseSnapshot;
}

/**
 * Per-request context passed to middleware and route handlers. Each request
 * gets a fresh context; request-scoped data lives here, never in globals.
 *
 * @since 0.1.0
 */
export interface IRequestContext {
  /** Unique request ID (generated or propagated by middleware). */
  readonly id: string;
  /** The incoming request. */
  readonly request: IRequest;
  /** The response builder. */
  readonly response: IResponse;
  /** Service resolution (application-scoped plus request-scoped services). */
  readonly services: IServiceRegistry;
  /** Path parameters extracted by the router (e.g. `:id`). */
  readonly params: Readonly<Record<string, string>>;
  /** Query string parameters. */
  readonly query: Readonly<Record<string, string>>;
  /** Request-scoped state for passing data between middleware and handlers. */
  readonly state: Map<string, unknown>;
  /** High-resolution timestamp captured when the context was created. */
  readonly startTime: number;
  /**
   * An abort signal that fires when the underlying HTTP connection is severed
   * (client disconnect, timeout). Populated by {@linkcode createRequestContext}
   * from the native `Request.signal`; falls back to a non-aborting sentinel so
   * handlers always have a live signal to listen on.
   *
   * Used by streaming producers (SSE heartbeats, channel cleanup) to stop
   * work on client disconnect and avoid leaking producers.
   *
   * @since 0.2.0
   */
  readonly signal: AbortSignal;
}

/**
 * Continues the middleware pipeline. Not calling it short-circuits the
 * pipeline (the caller must have produced a response).
 *
 * @since 0.1.0
 */
export type NextFunction = () => Promise<void>;

/**
 * A middleware function: pre-process, call `next()`, post-process. May
 * short-circuit by returning a response without calling `next()`.
 *
 * @example
 * ```typescript
 * const timing: MiddlewareFunction = async (ctx, next) => {
 *   const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
 *   await next();
 *   // ctx.startTime is a monotonic runtime.hrtime() reading; subtract it from
 *   // another monotonic reading — never from a wall-clock epoch.
 *   ctx.response.header('X-Duration', String(runtime.hrtime() - ctx.startTime));
 * };
 * ```
 * @since 0.1.0
 */
export type MiddlewareFunction = (
  ctx: IRequestContext,
  next: NextFunction,
) => void | HandlerResult | Promise<void | HandlerResult>;

/**
 * Object form of middleware, for implementations that carry state.
 *
 * @since 0.1.0
 */
export interface IMiddleware {
  /**
   * Handles the request.
   *
   * @param ctx - The request context
   * @param next - Continues the pipeline
   * @returns Optionally a handler result when short-circuiting
   */
  handle(
    ctx: IRequestContext,
    next: NextFunction,
  ): void | HandlerResult | Promise<void | HandlerResult>;
}

/**
 * A route handler: receives the request context and returns a response via
 * the context's response builder.
 *
 * @since 0.1.0
 */
export type RouteHandler = (ctx: IRequestContext) => HandlerResult | Promise<HandlerResult>;

/**
 * Validation/documentation schemas attached to a route. Schema values are
 * intentionally `unknown` here — the validation plugin narrows them (Zod
 * schemas by default) so `common` stays dependency-free.
 *
 * @since 0.1.0
 */
export interface RouteSchema {
  /** Request body schema. */
  readonly body?: unknown;
  /** Query parameter schema. */
  readonly query?: unknown;
  /** Path parameter schema. */
  readonly params?: unknown;
  /** Header schema. */
  readonly headers?: unknown;
  /** Response schemas keyed by status code. */
  readonly response?: Readonly<Record<number, unknown>>;
  /** OpenAPI tags. */
  readonly tags?: readonly string[];
  /** OpenAPI operation summary. */
  readonly summary?: string;
}

/**
 * Full route definition, used when a route needs middleware or schemas in
 * addition to its handler.
 *
 * @since 0.1.0
 */
export interface RouteDefinition {
  /** The route handler. */
  readonly handler: RouteHandler;
  /** Route-level middleware, executed before the handler. */
  readonly middleware?: readonly MiddlewareFunction[];
  /** Validation and OpenAPI schemas. */
  readonly schema?: RouteSchema;
}

/**
 * Discriminated union representing the possible shapes of an {@linkcode IResponse} snapshot.
 * When `streaming` is `false`, `body` is a buffered `Uint8Array | string | null`.
 * When `streaming` is `true`, `body` is a live `ReadableStream<Uint8Array>`.
 *
 * @since 0.2.0
 */
export type ResponseSnapshot =
  | {
    readonly streaming: false;
    readonly status: number;
    readonly headers: Headers;
    readonly body: Uint8Array | string | null;
  }
  | {
    readonly streaming: true;
    readonly status: number;
    readonly headers: Headers;
    readonly body: ReadableStream<Uint8Array>;
  };
