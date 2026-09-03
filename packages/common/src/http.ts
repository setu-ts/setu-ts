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
import type { ITenant } from './services/tenancy.ts';
import type { ValidationTarget } from './services/validation.ts';

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
   *
   * It accepts one implicit write per request; a second assignment throws so
   * independent identity writers fail loudly. Use {@linkcode replacePrincipal}
   * for an intentional replacement such as step-up authentication. This is
   * not an authorization control: a write before authentication is still the
   * first write and is allowed.
   */
  user?: IPrincipal;
  /**
   * The resolved tenant, populated by the multi-tenancy middleware.
   * Absent when no tenant could be resolved or multi-tenancy is not enabled.
   *
   * It accepts one implicit write per request; use {@linkcode replaceTenant}
   * for an intentional replacement. Like `user`, this detects late accidental
   * overwrites and is not an authorization control.
   */
  tenant?: ITenant;
  /**
   * An abort signal that fires when the underlying HTTP connection is
   * severed (client disconnect, timeout). Populated by the HTTP adapter
   * from the native `Request.signal`; optional because injected / test
   * requests may not carry one.
   *
   * When absent, the kernel's request-context factory falls back to a
   * non-aborting sentinel so that producers reading
   * {@linkcode IRequestContext.signal} always have a live signal to listen on.
   */
  signal?: AbortSignal;
  /**
   * The undisturbed web-standard `Request`, preserved for WebSocket upgrade
   * and gRPC dispatch after the middleware pipeline.
   *
   * Populated by the HTTP adapter before the body is consumed by the
   * framework mapping. Optional because injected or test requests may not
   * carry one.
   *
   * @since 0.3.0
   */
  readonly raw?: Request;
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
   * Sends an HTML response.
   *
   * The `text/html; charset=utf-8` media type is set explicitly — a bare
   * `text/html` lets a browser sniff the encoding.
   *
   * @param body - The HTML document text
   * @returns The handler result
   * @since 0.2.0
   */
  html(body: string): HandlerResult;
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
   * Returns a snapshot of the current response state (status, headers, body).
   * Enables middleware to inspect the response after `next()` returns —
   * required for transparent response caching.
   *
   * The returned object is a READ view, not a defensive copy: `headers` is the
   * live `Headers` instance backing the response. Treat it as read-only —
   * mutating it mutates the response. (No copy is taken deliberately: cloning a
   * `Headers` collapses repeated `Set-Cookie` values into one comma-joined
   * header, which would corrupt multi-cookie responses.)
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
   * (client disconnect, timeout). Populated by the kernel's request-context
   * factory from the native `Request.signal`; falls back to a non-aborting
   * sentinel so handlers always have a live signal to listen on.
   *
   * Used by streaming producers (SSE heartbeats, channel cleanup) to stop
   * work on client disconnect and avoid leaking producers.
   *
   * @since 0.2.0
   */
  readonly signal: AbortSignal;
  /**
   * The undisturbed web-standard `Request`, preserved for WebSocket upgrade
   * and gRPC dispatch after the middleware pipeline.
   *
   * Threaded from {@linkcode IRequest.raw} by the kernel's request-context
   * factory. Absent when the adapter did not provide one (injected or test
   * requests).
   *
   * @since 0.3.0
   */
  readonly raw?: Request;
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
 * Reports whether a value is thenable, by the same duck-typed test the
 * platform serve layers use rather than `instanceof Promise`.
 *
 * The distinction is load-bearing on the request path (M87). `instanceof`
 * asks whether a value was built by *this realm's* `Promise` constructor, and
 * answers `false` for a promise from another realm (a `vm` context, a worker)
 * and for every userland promise library. Those values satisfy
 * {@linkcode RouteHandler}'s declared `Promise<HandlerResult>` structurally,
 * so TypeScript accepts them and only the runtime check can tell them apart —
 * and a request path that treats one as "already finished" sends the response
 * while the handler is still running, with no error anywhere.
 *
 * Both `@setu-ts/kernel` and `@setu-ts/runtime` decide "did this need
 * awaiting?" on the hot path, so the rule lives here and neither can drift
 * from the other about what counts as asynchronous.
 *
 * @typeParam T - The value the thenable resolves to, preserved by the guard so
 * the narrowed branch keeps its type rather than widening to `unknown`
 * @param value - Any value a handler or framework layer produced
 * @returns `true` when the value exposes a callable `then`
 * @example
 * ```typescript
 * const result = handler(ctx);
 * // `Promise.resolve` returns a native promise unchanged, and adopts a
 * // foreign thenable, so the fast path allocates nothing.
 * return isPromiseLike(result) ? Promise.resolve(result) : undefined;
 * ```
 * @since 0.3.0
 */
export function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

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
  /**
   * OpenAPI security requirements for this operation, overriding any
   * document-level default. Each entry names a scheme declared in the
   * document's `components.securitySchemes` and lists the scopes it needs
   * (empty for non-OAuth2 schemes such as HTTP bearer or API key).
   *
   * An empty array is meaningful and is NOT the same as omitting the field:
   * per the OpenAPI specification it declares the operation **public**, which
   * is how a route opts out of a document-level requirement. Omitting the
   * field leaves the operation inheriting whatever the document declares.
   *
   * Declaring this does not enforce anything — authentication is enforced by
   * middleware and guards. This describes the route for documentation and
   * client generation.
   *
   * Declaring is not the only way a document learns about authentication: a
   * requirement can instead be DERIVED from guards branded with
   * {@linkcode RouteSecurityMetadata}, which is what `@setu-ts/auth-plugin`'s
   * guards carry. A value declared here always wins over a derived one.
   *
   * @example
   * ```typescript
   * // Requires the `bearerAuth` scheme:
   * app.router.get('/todos/:id', {
   *   schema: { security: [{ bearerAuth: [] }] },
   *   handler,
   * });
   *
   * // Explicitly public, even when the document requires auth by default:
   * app.router.post('/login', { schema: { security: [] }, handler });
   * ```
   *
   * @since 0.2.0
   */
  readonly security?: readonly SecurityRequirement[];
}

/**
 * A single OpenAPI security requirement: a map of security-scheme name to the
 * scopes that scheme must grant. Scopes are meaningful only for OAuth2 and
 * OpenID Connect schemes; every other scheme type takes an empty array.
 *
 * Multiple entries in a requirement object are ANDed (all must be satisfied);
 * multiple requirement objects in a list are ORed (any one satisfies).
 *
 * @example
 * ```typescript
 * const bearer: SecurityRequirement = { bearerAuth: [] };
 * const scoped: SecurityRequirement = { oauth2: ['read:todos', 'write:todos'] };
 * ```
 *
 * @since 0.2.0
 */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

/**
 * Key under which a {@linkcode MiddlewareFunction} carries its
 * {@linkcode RouteSecurityMetadata}.
 *
 * Created with `Symbol.for`, not `Symbol()`, so two copies of this package in
 * one process resolve the same key — the failure mode a locally-constructed
 * symbol would produce silently, since every read would simply miss.
 *
 * Prefer {@linkcode withSecurityMetadata} and {@linkcode securityMetadataOf}
 * over touching this directly; the symbol is exported so a guard outside
 * `@setu-ts/auth-plugin` can be branded too.
 *
 * @since 0.2.0
 */
export const SECURITY_METADATA: unique symbol = Symbol.for('setu.security.metadata');

/**
 * Key under which the kernel terminal handler brands an {@linkcode IRequest}
 * with a WebSocket upgrade intent.
 *
 * Created with `Symbol.for`, not `Symbol()`, so two copies of this package in
 * one process resolve the same key — the {@linkcode SECURITY_METADATA}
 * precedent.
 *
 * The `IRequest` is the channel rather than `IRequestContext.state`, and that
 * is a correctness requirement rather than a preference: the HTTP adapter
 * holds the `IRequest` it built and hands to the framework handler, and never
 * sees the `IRequestContext` — the kernel creates the context internally and
 * discards it when the handler returns. There is no path by which a value
 * written to `ctx.state` could reach the adapter that must perform the
 * handshake.
 *
 * Prefer {@linkcode setUpgradeIntent} and {@linkcode upgradeIntentOf} over
 * touching this directly; the symbol is exported so a custom adapter outside
 * `@setu-ts/runtime` can read the brand.
 *
 * @since 0.3.0
 */
export const UPGRADE_INTENT: unique symbol = Symbol.for('setu.upgrade.intent');

/**
 * The WebSocket upgrade intent the kernel terminal handler brands onto an
 * {@linkcode IRequest} under {@linkcode UPGRADE_INTENT}, for the HTTP adapter
 * to act on once the middleware pipeline has run without short-circuiting.
 *
 * @since 0.3.0
 */
export interface WebSocketUpgradeIntent {
  /** The sink the adapter binds its native socket events into. */
  readonly sink: import('./services/websocket.ts').WebSocketEventSink;
  /** The negotiated subprotocol to echo back, when one was selected. */
  readonly protocol?: string | undefined;
}

/** The private brand shape carried on an {@linkcode IRequest}. */
type UpgradeBranded = { [UPGRADE_INTENT]?: WebSocketUpgradeIntent };

/**
 * Brands a request with a WebSocket upgrade intent for the HTTP adapter to
 * act on after the framework handler returns.
 *
 * Called by the kernel terminal handler once the pipeline has run without
 * short-circuiting and the upgrade router has accepted.
 *
 * @param request - The framework request the adapter built
 * @param intent - The sink and negotiated subprotocol
 * @since 0.3.0
 */
export function setUpgradeIntent(request: IRequest, intent: WebSocketUpgradeIntent): void {
  (request as IRequest & UpgradeBranded)[UPGRADE_INTENT] = intent;
}

/**
 * Reads the WebSocket upgrade intent an adapter should act on, or `undefined`
 * when the pipeline did not ask for an upgrade.
 *
 * @param request - The framework request the adapter passed to the handler
 * @returns The intent, or `undefined` when none was recorded
 * @since 0.3.0
 */
export function upgradeIntentOf(request: IRequest): WebSocketUpgradeIntent | undefined {
  return (request as IRequest & UpgradeBranded)[UPGRADE_INTENT];
}

/**
 * Reports whether a set of request headers describes an RFC 6455 WebSocket
 * upgrade.
 *
 * Both conditions are required, per RFC 6455 §4.2.1: `Upgrade` must equal
 * `websocket` (case-insensitively), and `Connection` must contain the
 * `upgrade` token. `Connection` is a comma-separated list — proxies routinely
 * send `keep-alive, Upgrade` — so it is matched token-wise rather than by
 * substring, which would also match a header value such as `no-upgrade`.
 *
 * Lives here rather than in `@setu-ts/runtime` because the kernel decides
 * whether a request is an upgrade (after the pipeline runs) while the adapters
 * still need the identical rule, and the kernel does not depend on the runtime
 * package. A pure predicate is exactly what `common` is for (AI_GUIDELINES
 * §2.1); `@setu-ts/runtime` re-exports this one rather than keeping a second
 * copy (§11.1).
 *
 * @param headers - The request headers
 * @returns `true` when the request asks for a WebSocket upgrade
 * @example
 * ```typescript
 * if (isWebSocketUpgradeRequest(request.headers)) {
 *   // consult the upgrade router
 * }
 * ```
 * @since 0.3.0
 */
export function isWebSocketUpgradeRequest(headers: Headers): boolean {
  const upgrade = headers.get('upgrade');
  if (upgrade === null || upgrade.trim().toLowerCase() !== 'websocket') {
    return false;
  }

  const connection = headers.get('connection');
  if (connection === null) {
    return false;
  }

  return connection
    .split(',')
    .some((token) => token.trim().toLowerCase() === 'upgrade');
}

/**
 * What a middleware function enforces, for documentation generators.
 *
 * This is a **description**, not a mechanism: the middleware still performs
 * the enforcement, and removing the metadata changes no runtime behaviour.
 *
 * It deliberately carries authentication PRESENCE only. An OpenAPI security
 * requirement names a scheme, and no declared scheme can be inferred from a
 * role name, so roles and permissions are not represented here — see
 * `@setu-ts/openapi-plugin` for what a generated document can and cannot say.
 *
 * @since 0.2.0
 */
export interface RouteSecurityMetadata {
  /**
   * `true` when the middleware requires an authenticated principal; `false`
   * when it explicitly marks the route public.
   */
  readonly authenticated: boolean;
}

/**
 * Brands a middleware function with the security it enforces, so a
 * documentation generator can read it without importing the plugin that
 * produced it.
 *
 * The function is branded in place and returned, so identity is preserved and
 * the brand costs no wrapper frame per request. The property is symbol-keyed
 * and non-enumerable, so it is invisible to `Object.keys`, `JSON.stringify`
 * and spread, and the middleware behaves exactly as it did.
 *
 * @param middleware - The middleware to brand
 * @param metadata - What the middleware enforces
 * @returns The same `middleware` reference, branded
 *
 * @example
 * ```typescript
 * export function requireAuth(): MiddlewareFunction {
 *   return withSecurityMetadata(async (ctx, next) => {
 *     if (!ctx.request.user) return void ctx.response.status(401).json({ error: 'Unauthorized' });
 *     await next();
 *   }, { authenticated: true });
 * }
 * ```
 *
 * @since 0.2.0
 */
export function withSecurityMetadata<T extends MiddlewareFunction>(
  middleware: T,
  metadata: RouteSecurityMetadata,
): T {
  Object.defineProperty(middleware, SECURITY_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return middleware;
}

/**
 * Reads the security metadata a middleware function was branded with.
 *
 * @param middleware - The middleware to inspect
 * @returns The metadata, or `undefined` when the middleware carries none
 *
 * @example
 * ```typescript
 * const guarded = (route.definition.middleware ?? []).some(
 *   (fn) => securityMetadataOf(fn)?.authenticated === true,
 * );
 * ```
 *
 * @since 0.2.0
 */
export function securityMetadataOf(
  middleware: MiddlewareFunction,
): RouteSecurityMetadata | undefined {
  const carrier = middleware as MiddlewareFunction & {
    readonly [SECURITY_METADATA]?: unknown;
  };
  const value = carrier[SECURITY_METADATA];
  return isRouteSecurityMetadata(value) ? value : undefined;
}

/**
 * Narrows an unknown branded value. A foreign value under the same global
 * symbol is treated as absent rather than trusted.
 */
function isRouteSecurityMetadata(value: unknown): value is RouteSecurityMetadata {
  return typeof value === 'object' && value !== null &&
    typeof (value as { authenticated?: unknown }).authenticated === 'boolean';
}

/**
 * Key under which a {@linkcode MiddlewareFunction} carries its
 * {@linkcode RouteValidationMetadata}.
 *
 * Created with `Symbol.for`, not `Symbol()`, so two copies of this package in
 * one process resolve the same key — the {@linkcode SECURITY_METADATA}
 * precedent, and for the same reason: a locally-created symbol would simply
 * miss on every read, silently.
 *
 * Prefer {@linkcode withValidationMetadata} and {@linkcode validationMetadataOf}
 * over touching this directly; the symbol is exported so a validating
 * middleware outside `@setu-ts/validation-plugin` can be branded too.
 *
 * @since 0.3.0
 */
export const VALIDATION_METADATA: unique symbol = Symbol.for('setu.validation.metadata');

/**
 * What a validating middleware checks, branded onto the middleware function
 * so a documentation generator can describe the route without importing the
 * plugin that produced it.
 *
 * This is a **description**, not a mechanism: the middleware still performs
 * the validation, and removing the metadata changes no runtime behaviour.
 *
 * The `schema` is carried verbatim — the same object the caller passed — so a
 * reader transforms it with whatever schema support it already has. It is
 * typed `unknown` rather than a Zod type because `@setu-ts/common` depends on
 * nothing and the validation contract accepts any object exposing `safeParse`.
 *
 * @since 0.3.0
 */
export interface RouteValidationMetadata {
  /** Which part of the request the middleware validates. */
  readonly target: ValidationTarget;
  /** The schema it validates against, exactly as the caller supplied it. */
  readonly schema: unknown;
}

/**
 * Brands a middleware function with the request part and schema it validates,
 * so a documentation generator can read it without importing the plugin that
 * produced it.
 *
 * The function is branded in place and returned, so identity is preserved and
 * the brand costs no wrapper frame per request. The property is symbol-keyed
 * and non-enumerable, so it is invisible to `Object.keys`, `JSON.stringify`
 * and spread, and the middleware behaves exactly as it did.
 *
 * @param middleware - The middleware to brand
 * @param metadata - The request part it validates, and against what
 * @returns The same `middleware` reference, branded
 *
 * @example
 * ```typescript
 * export function validateBody(schema: unknown): MiddlewareFunction {
 *   return withValidationMetadata(async (ctx, next) => {
 *     // ... validate ctx.request body against `schema` ...
 *     await next();
 *   }, { target: 'body', schema });
 * }
 * ```
 *
 * @since 0.3.0
 */
export function withValidationMetadata<T extends MiddlewareFunction>(
  middleware: T,
  metadata: RouteValidationMetadata,
): T {
  Object.defineProperty(middleware, VALIDATION_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return middleware;
}

/**
 * Reads the validation metadata a middleware function was branded with.
 *
 * @param middleware - The middleware to inspect
 * @returns The metadata, or `undefined` when the middleware carries none
 *
 * @example
 * ```typescript
 * for (const fn of route.definition.middleware ?? []) {
 *   const meta = validationMetadataOf(fn);
 *   if (meta?.target === 'body') documentRequestBody(meta.schema);
 * }
 * ```
 *
 * @since 0.3.0
 */
export function validationMetadataOf(
  middleware: MiddlewareFunction,
): RouteValidationMetadata | undefined {
  const carrier = middleware as MiddlewareFunction & {
    readonly [VALIDATION_METADATA]?: unknown;
  };
  const value = carrier[VALIDATION_METADATA];
  return isRouteValidationMetadata(value) ? value : undefined;
}

/**
 * Narrows an unknown branded value. A foreign value under the same global
 * symbol is treated as absent rather than trusted.
 *
 * `schema` is deliberately NOT checked beyond presence: it is `unknown` by
 * contract, and any object may legitimately appear there.
 */
function isRouteValidationMetadata(value: unknown): value is RouteValidationMetadata {
  if (typeof value !== 'object' || value === null) return false;
  // `schema` must be PRESENT, not merely declared by the type. A foreign value
  // branded under the same `Symbol.for` key with only a `target` otherwise read
  // back as valid metadata, and the OpenAPI generator counted that as a
  // derivation — adding a `400` response to an operation from which nothing was
  // actually derived.
  if (!('schema' in value)) return false;
  const target = (value as { target?: unknown }).target;
  return target === 'body' || target === 'query' || target === 'params' ||
    target === 'headers' || target === 'cookies';
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
    /**
     * Header input the runtime may pass directly to `new Response` before it
     * reads the lazy {@linkcode headers} view.
     *
     * @internal
     */
    readonly responseInit?: ResponseSnapshotInit | undefined;
  }
  | {
    readonly streaming: true;
    readonly status: number;
    readonly headers: Headers;
    readonly body: ReadableStream<Uint8Array>;
    /**
     * Header input the runtime may pass directly to `new Response` before it
     * reads the lazy {@linkcode headers} view.
     *
     * @internal
     */
    readonly responseInit?: ResponseSnapshotInit | undefined;
  };

/**
 * Native-response initialization data attached to a snapshot by the kernel
 * when its headers have not needed a mutable {@linkcode Headers} instance.
 *
 * HTTP adapters consume this private-by-convention protocol before reading
 * {@linkcode ResponseSnapshot.headers}. Application and middleware code should
 * continue to use `snapshot.headers`, which remains the documented live view.
 *
 * @since 0.4.0
 */
export interface ResponseSnapshotInit {
  /** Header input accepted directly by the web-standard `Response` constructor. */
  readonly headers: HeadersInit;
}
