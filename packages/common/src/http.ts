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
  readonly user?: IPrincipal;
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
 *   const start = ctx.startTime;
 *   await next();
 *   ctx.response.header('X-Duration', String(performance.now() - start));
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
