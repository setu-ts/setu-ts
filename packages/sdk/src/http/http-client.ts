/**
 * Internal HttpClient implementation.
 *
 * Composes URL building, query serialization, request/response interceptors,
 * JSON body serialization/parsing, retry, circuit breaker, rate limiting, and
 * abort support. Not exported from the barrel — consumers receive `IHttpClient`.
 *
 * @internal
 */

import type {
  ClientOptions,
  ClientRequest,
  ClientRequestContext,
  ClientResponse,
  IClientTiming,
  IHttpClient,
} from './contracts.ts';
import type { CircuitBreakerPolicy, RetryPolicy } from 'jsr:@hono-enterprise/common@^0.1.0-alpha.2';

import { HttpClientError } from '../errors.ts';
import { createCircuitBreaker } from '../circuit-breaker/circuit-breaker.ts';
import { runWithRetry } from '../retry/retry-strategy.ts';
import { createRateLimiter } from './rate-limiter.ts';

// Origin-keyed breaker and limiter maps.
interface OriginBreaker {
  execute: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface OriginLimiter {
  acquire: (signal?: AbortSignal) => Promise<void>;
}

/**
 * Internal HTTP client implementing `IHttpClient`.
 *
 * @internal
 */
export class HttpClient implements IHttpClient {
  #baseUrl: string;
  #defaultHeaders: HeadersInit | undefined;
  #fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  #timing: IClientTiming;
  #retry: RetryPolicy | undefined;
  #circuitBreaker: CircuitBreakerPolicy | undefined;
  #maxRequests: number | undefined;
  #windowMs: number | undefined;
  #requestInterceptors: ((ctx: ClientRequestContext) => void | Promise<void>)[];
  #responseInterceptors: ((
    response: ClientResponse<unknown>,
    request: ClientRequestContext,
  ) => ClientResponse<unknown> | Promise<ClientResponse<unknown>>)[];

  #breakers = new Map<string, OriginBreaker>();
  #limiters = new Map<string, OriginLimiter>();

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#defaultHeaders = options.headers;
    this.#fetch = options.fetch ?? fetch;
    this.#timing = options.timing!; // guaranteed by createClient
    this.#retry = options.retry;
    this.#circuitBreaker = options.circuitBreaker;
    this.#maxRequests = options.rateLimit?.maxRequests;
    this.#windowMs = options.rateLimit?.windowMs;
    this.#requestInterceptors = options.requestInterceptors ?? [];
    this.#responseInterceptors = options.responseInterceptors ?? [];
  }

  async request<TResponse, TBody = unknown>(
    req: ClientRequest<TBody>,
  ): Promise<ClientResponse<TResponse>> {
    // Resolve URL from baseUrl + path.
    if (req.path.startsWith('/')) {
      throw new Error('ClientRequest.path must be relative (no leading slash).');
    }
    const url = new URL(req.path, this.#baseUrl);

    // Build query string.
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // Build headers: defaults → request-specific.
    const headers = new Headers(this.#defaultHeaders);
    if (req.headers) {
      const init = req.headers;
      if (init instanceof Headers) {
        for (const [k, v] of init.entries()) headers.set(k, v);
      } else if (Array.isArray(init)) {
        for (const [k, v] of init) headers.set(k, v);
      } else {
        for (const [k, v] of Object.entries(init)) {
          if (v !== undefined) headers.set(k, v);
        }
      }
    }

    // Build request body.
    let body: string | undefined;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers.set('Content-Type', 'application/json');
    }

    // Run request interceptors.
    const requestContext: ClientRequestContext = { url, headers };
    for (const interceptor of this.#requestInterceptors) {
      await interceptor(requestContext);
    }

    // Extract origin for per-origin policy gates.
    const origin = url.origin;

    // Get or create origin breaker.
    let breaker = this.#breakers.get(origin);
    if (this.#circuitBreaker && !breaker) {
      breaker = createCircuitBreaker(this.#circuitBreaker, this.#timing, (error) => {
        // Only server errors (5xx) and transport failures trip the breaker.
        // User errors (4xx) do NOT count as circuit-breaking failures.
        if (error instanceof HttpClientError) return error.status >= 500;
        if (error instanceof DOMException && error.name === 'AbortError') return false;
        return true;
      });
      this.#breakers.set(origin, breaker);
    }

    // Get or create origin limiter.
    let limiter = this.#limiters.get(origin);
    if (this.#maxRequests && this.#windowMs && !limiter) {
      limiter = createRateLimiter(this.#maxRequests, this.#windowMs, this.#timing);
      this.#limiters.set(origin, limiter);
    }

    const execute = async (): Promise<ClientResponse<TResponse>> => {
      // Rate-limit gate.
      if (limiter) {
        await limiter.acquire(req.signal);
      }

      // Fetch.
      const fetchInit: RequestInit = {
        method: req.method,
        headers,
      };
      if (body !== undefined) {
        fetchInit.body = body;
      }
      if (req.signal !== undefined) {
        fetchInit.signal = req.signal;
      }
      const response = await this.#fetch(url.toString(), fetchInit);

      // Non-2xx → throw HttpClientError.
      if (response.status < 200 || response.status >= 300) {
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          try {
            errorBody = await response.text();
          } catch {
            // Body already consumed by failed json() parse.
            errorBody = undefined;
          }
        }
        throw new HttpClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          response.headers,
          errorBody,
        );
      }

      // Parse response body.
      let data: TResponse | undefined;
      if (response.status !== 204) {
        const ct = response.headers.get('Content-Type');
        if (ct && ct.includes('application/json')) {
          const text = await response.text();
          if (text) {
            try {
              data = JSON.parse(text) as TResponse;
            } catch {
              throw new Error('Failed to parse JSON response body.');
            }
          }
        }
      }

      const clientResponse: ClientResponse<TResponse> = {
        status: response.status,
        headers: response.headers,
        data,
      };

      // Run response interceptors (only on success).
      let result: ClientResponse<TResponse> = clientResponse as ClientResponse<TResponse>;
      for (const interceptor of this.#responseInterceptors) {
        result = await interceptor(
          result as ClientResponse<unknown>,
          requestContext,
        ) as ClientResponse<TResponse>;
      }

      return result;
    };

    // Compose: retry → breaker.
    // Use explicit function references to avoid closure capturing a mutable variable,
    // which would create an infinite loop (breaker → guarded → breaker → ...).

    // Inner: the base execute (HTTP call + interceptors).
    let inner: () => Promise<ClientResponse<TResponse>> = execute;

    // Wrap with retry (retry calls `inner`, which is the base execute).
    if (this.#retry) {
      const retry = this.#retry;
      const method = req.method;
      const timing = this.#timing;
      const signal = req.signal;
      const base = inner;
      inner = () => runWithRetry(base, retry, method, timing, signal);
    }

    // Wrap with circuit breaker (breaker calls `inner`, which includes retry).
    if (breaker) {
      const b = breaker;
      const withRetry = inner;
      inner = () => b.execute(withRetry);
    }

    return inner();
  }
}
