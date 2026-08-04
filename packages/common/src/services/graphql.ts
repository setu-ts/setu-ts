/**
 * GraphQL service contract for the GraphQL plugin.
 *
 * This module defines the structural interface for GraphQL execution
 * that is independent of the HTTP transport. The plugin registers an
 * implementation of {@linkcode IGraphqlService} under the
 * {@linkcode CAPABILITIES.GRAPHQL} token.
 *
 * @module
 */

import type { IRequestContext } from '../http.ts';

/**
 * Parameters for a GraphQL execution request.
 *
 * These are produced by the HTTP request parser and consumed by
 * {@linkcode IGraphqlService.execute}.
 *
 * @since 0.1.0
 */
export interface GraphqlRequestParams {
  /** The GraphQL query string. */
  query: string;
  /** Operation name for documents with multiple operations. */
  operationName?: string;
  /** Variables as a record of unknown values (passed through verbatim). */
  variables?: Record<string, unknown>;
  /**
   * Optional extensions carried with the request.
   *
   * Used by Automatic Persisted Queries (APQ) to pass `{ version, sha256Hash }`
   * under the `persistedQuery` key. Other extensions are forwarded without
   * interpretation by the framework.
   *
   * @since 0.3.0
   */
  extensions?: Record<string, unknown>;
}

/**
 * Formatted GraphQL error as returned to the client.
 *
 * This matches the GraphQL-over-HTTP spec shape. The plugin masks
 * internal errors before formatting.
 *
 * @since 0.1.0
 */
export interface GraphqlFormattedError {
  /** Human-readable error message. */
  message: string;
  /** Optional locations in the query document. */
  locations?: Array<{ line: number; column: number }>;
  /** Optional path to the field where the error occurred. */
  path?: Array<string | number>;
  /** Optional extensions for application-specific error codes. */
  extensions?: Record<string, unknown>;
}

/**
 * The execution result as specified by the GraphQL spec.
 *
 * @since 0.1.0
 */
export interface GraphqlExecutionResult {
  /** The data returned by the execution, or null if an error occurred. */
  data?: Record<string, unknown> | null;
  /** Errors encountered during execution, or undefined if none. */
  errors?: GraphqlFormattedError[];
}

/**
 * The outcome of a GraphQL execution, carrying an HTTP status code
 * for the transport layer to use.
 *
 * @since 0.1.0
 */
export interface GraphqlExecutionOutcome {
  /**
   * The HTTP status code to return under
   * `application/graphql-response+json` negotiation.
   *
   * A request error (parse, validation, operation resolution) is `400`; a
   * mutation over `GET` is `405`. An operation that actually executed is `200`
   * even when a field error nulls `data` — a field error is not a request
   * error.
   */
  status: number;
  /** The execution result (may contain errors). */
  result: GraphqlExecutionResult;
}

/**
 * Information about a WebSocket connection used for subscription operations.
 *
 * Built from {@linkcode WebSocketConnectionContext} and the `connection_init`
 * payload. Supplied by the WS transport path; absent on the SSE/HTTP paths.
 *
 * @since 0.3.0
 */
export interface GraphqlConnectionInfo {
  /** Unique connection identifier. */
  readonly id: string;
  /** The payload sent with `connection_init`, if any. */
  readonly connectionParams?: Record<string, unknown>;
  /** The upgrade request headers. */
  readonly headers: Headers;
  /** Query string parameters from the upgrade request. */
  readonly query: Readonly<Record<string, string>>;
  /** The negotiated subprotocol, when one was selected. */
  readonly protocol?: string;
  /** Per-connection application state. */
  readonly data: Map<string, unknown>;
}

/**
 * Context for a subscription operation, carrying either an HTTP request context
 * or a WebSocket connection info.
 *
 * The SSE path supplies {@linkcode requestContext}; the WS path supplies
 * {@linkcode connection}. Using this type (instead of {@linkcode IRequestContext})
 * prevents the WS path from silently handing resolvers an empty context.
 *
 * @since 0.3.0
 */
export interface GraphqlOperationContext {
  /** The HTTP request context (supplied by the SSE path). */
  readonly requestContext?: IRequestContext;
  /** The WebSocket connection info (supplied by the WS path). */
  readonly connection?: GraphqlConnectionInfo;
}

/**
 * Discriminated outcome of a subscription operation.
 *
 * Three arms because the wire needs the distinction:
 * - `'error'` — a request error (parse, validation, operation resolution);
 *   the WS transport emits `error` and NO `complete`.
 * - `'single'` — a query or mutation that executed; one `next` then `complete`.
 * - `'stream'` — a true subscription; many `next` then `complete`.
 *
 * @since 0.3.0
 */
export type GraphqlSubscriptionOutcome =
  | { kind: 'error'; status: number; result: GraphqlExecutionResult }
  | { kind: 'single'; status: number; result: GraphqlExecutionResult }
  | {
    kind: 'stream';
    status: number;
    stream: AsyncIterable<GraphqlExecutionResult>;
  };

/**
 * The GraphQL service contract.
 *
 * Implementations register themselves under {@linkcode CAPABILITIES.GRAPHQL}
 * and are responsible for parsing, validating, and executing GraphQL requests.
 * The HTTP transport layer calls this service and handles media-type negotiation.
 *
 * @since 0.1.0
 */
export interface IGraphqlService {
  /**
   * Execute a GraphQL request.
   *
   * @param params - The parsed GraphQL request parameters
   * @param requestContext - Optional request context for service resolution
   * @param method - Optional HTTP method (used for operation-kind guard)
   * @returns The execution outcome with HTTP status
   */
  execute(
    params: GraphqlRequestParams,
    requestContext?: IRequestContext,
    method?: 'GET' | 'POST',
  ): Promise<GraphqlExecutionOutcome>;

  /**
   * Subscribe to a GraphQL operation (query, mutation, or subscription).
   *
   * Accepts every operation kind and returns the matching discriminated outcome.
   * The transports narrow on the `kind` field to emit conformant frames.
   *
   * @param params - The parsed GraphQL request parameters
   * @param context - Optional operation context (request or connection)
   * @returns The discriminated subscription outcome
   * @since 0.3.0
   */
  subscribe(
    params: GraphqlRequestParams,
    context?: GraphqlOperationContext,
  ): Promise<GraphqlSubscriptionOutcome>;

  /**
   * The endpoint path where GraphQL is served.
   */
  readonly endpoint: string;

  /**
   * Report the number of cached documents.
   */
  readonly cachedDocumentCount: number;
}
