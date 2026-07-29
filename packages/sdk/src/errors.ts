/**
 * SDK error classes.
 *
 * Three exported error classes for catching specific failure modes:
 * `HttpClientError` (non-2xx HTTP), `ClientCircuitOpenError` (breaker open),
 * and `OpenApiCodegenError` (codegen diagnostics).
 *
 * @module
 */

/**
 * Thrown by `IHttpClient.request()` when the server returns a non-2xx status.
 *
 * @since 0.1.0
 */
export class HttpClientError extends Error {
  public readonly status: number;
  public readonly headers: Headers;
  public readonly body: unknown;

  constructor(message: string, status: number, headers: Headers, body: unknown) {
    super(message);
    this.name = 'HttpClientError';
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/**
 * Thrown when the circuit breaker for the target origin is open.
 *
 * Named `ClientCircuitOpenError` (not `CircuitOpenError`) to avoid a barrel
 * collision with `@hono-enterprise/resilience-plugin`.
 *
 * @since 0.1.0
 */
export class ClientCircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientCircuitOpenError';
  }
}

/**
 * Thrown by `generateOpenApiClient()` with path/method diagnostics when the
 * OpenAPI document is malformed or contains unsupported constructs.
 *
 * @since 0.1.0
 */
export class OpenApiCodegenError extends Error {
  public readonly path: string | undefined;
  public readonly method: string | undefined;

  constructor(message: string, path?: string, method?: string) {
    super(message);
    this.name = 'OpenApiCodegenError';
    this.path = path;
    this.method = method;
  }
}
