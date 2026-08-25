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
 * `TBody` is the parsed error payload. It defaults to `unknown`, so the bare
 * name `HttpClientError` keeps meaning exactly what it did and every existing
 * `catch (e) { if (e instanceof HttpClientError) … }` is unaffected. A
 * generated client narrows it through its own per-operation error guard, which
 * is how a document's declared 4xx schemas reach the caller — the throw site
 * itself cannot know which operation it is serving.
 *
 * @typeParam TBody - The parsed error response body.
 * @since 0.1.0
 */
export class HttpClientError<TBody = unknown> extends Error {
  public readonly status: number;
  public readonly headers: Headers;
  public readonly body: TBody;

  constructor(message: string, status: number, headers: Headers, body: TBody) {
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
 * collision with `@setu-ts/resilience-plugin`.
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
