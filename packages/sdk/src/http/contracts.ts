/**
 * HTTP client contracts for the SDK runtime.
 *
 * Defines the public interfaces, types, and re-exports that consumers use to
 * configure and interact with the HTTP client.
 *
 * @module
 */

// Re-export resilience policy types from common so consumers don't need a
// separate @hono-enterprise/common dependency.
import type {
  BackoffStrategy,
  CircuitBreakerPolicy,
  RetryPolicy,
} from 'jsr:@hono-enterprise/common@^0.1.0-alpha.3';

export type { BackoffStrategy, CircuitBreakerPolicy, RetryPolicy };

// ---------------------------------------------------------------------------
// Client request / response
// ---------------------------------------------------------------------------

/**
 * An outbound JSON request described by application or generated code.
 *
 * @since 0.1.0
 */
export interface ClientRequest<TBody = unknown> {
  /** HTTP method. */
  readonly method: string;

  /** Relative path resolved against the client `baseUrl`. Must be relative. */
  readonly path: string;

  /** Query values. Primitives are encoded once; arrays repeat the key. Nullish values are omitted. */
  readonly query?: Record<
    string,
    string | number | boolean | (string | number | boolean)[] | null | undefined
  >;

  /** Additional headers merged on top of the client defaults. */
  readonly headers?: HeadersInit;

  /** JSON body. When present, `Content-Type: application/json` is set automatically. */
  readonly json?: TBody;

  /** Abort signal that cancels fetches and queued waits. */
  readonly signal?: AbortSignal;
}

/**
 * A successful parsed response returned by {@linkcode IHttpClient.request}.
 *
 * @typeParam T - The deserialized response type.
 * @since 0.1.0
 */
export interface ClientResponse<T> {
  /** HTTP status code (always 2xx). */
  readonly status: number;

  /** Response headers. */
  readonly headers: Headers;

  /** Parsed JSON body. `undefined` for 204 or empty responses. */
  readonly data: T | undefined;
}

// ---------------------------------------------------------------------------
// Interceptors
// ---------------------------------------------------------------------------

/**
 * Mutable context passed to a {@linkcode ClientRequestInterceptor} so it can
 * inspect and modify the resolved URL and headers before the request executes.
 *
 * @since 0.1.0
 */
export interface ClientRequestContext {
  /** The fully-resolved request URL. */
  url: URL;

  /** The mutable header map for the outbound request. */
  headers: Headers;
}

/**
 * A request interceptor called once (before any retry attempt) in registration
 * order. Receives a mutable {@linkcode ClientRequestContext}.
 *
 * @since 0.1.0
 */
export type ClientRequestInterceptor = (ctx: ClientRequestContext) => void | Promise<void>;

/**
 * A response interceptor called after a successful JSON parse, in registration
 * order. Skipped entirely when the request throws.
 *
 * @typeParam T - The response data type.
 * @since 0.1.0
 */
export type ClientResponseInterceptor<T> = (
  response: ClientResponse<T>,
  request: ClientRequestContext,
) => ClientResponse<T> | Promise<ClientResponse<T>>;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * Monotonic-time and sleep abstraction used by retry, breaker, and rate-limiter.
 *
 * @since 0.1.0
 */
export interface IClientTiming {
  /** Monotonic timestamp in milliseconds (like `performance.now()`). */
  now(): number;

  /** Sleep for approximately `ms` milliseconds, abortable via `signal`. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Per-origin sliding-window rate-limit configuration.
 *
 * @since 0.1.0
 */
export interface ClientRateLimitPolicy {
  /** Maximum requests allowed within the window. */
  readonly maxRequests: number;

  /** Window size in milliseconds. */
  readonly windowMs: number;
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

/**
 * Options passed to `createClient()`.
 *
 * @since 0.1.0
 */
export interface ClientOptions {
  /** Required base URL for all requests. */
  readonly baseUrl: string;

  /** Default headers cloned into each request. */
  readonly headers?: HeadersInit;

  /** Injectable fetch seam. Defaults to global `fetch`. */
  readonly fetch?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;

  /** Timing abstraction. Defaults to `createDefaultClientTiming()`. */
  readonly timing?: IClientTiming;

  /** Retry policy. `limit < 1` throws at construction. */
  readonly retry?: RetryPolicy;

  /** Circuit breaker policy. `threshold < 1` throws at construction. */
  readonly circuitBreaker?: CircuitBreakerPolicy;

  /** Rate-limit policy. Non-positive `maxRequests` or `windowMs` throws. */
  readonly rateLimit?: ClientRateLimitPolicy;

  /** Request interceptors executed once before resilient execution. */
  readonly requestInterceptors?: ClientRequestInterceptor[];

  /** Response interceptors executed after successful parsing. */
  readonly responseInterceptors?: ClientResponseInterceptor<unknown>[];
}

// ---------------------------------------------------------------------------
// HTTP client interface
// ---------------------------------------------------------------------------

/**
 * The public HTTP client contract returned by `createClient()`.
 *
 * @since 0.1.0
 */
export interface IHttpClient {
  /**
   * Execute an outbound JSON request.
   *
   * @typeParam TResponse - Expected response type.
   * @typeParam TBody - Optional request body type.
   * @returns Resolved parsed response.
   * @throws {@linkcode HttpClientError} on non-2xx responses.
   * @throws {@linkcode ClientCircuitOpenError} when the circuit is open.
   */
  request<TResponse, TBody = unknown>(
    request: ClientRequest<TBody>,
  ): Promise<ClientResponse<TResponse>>;
}
