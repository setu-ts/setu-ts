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
  /** Optional extensions (reserved for M51b — Automatic Persisted Queries). */
  // extensions?: Record<string, unknown>; // omitted in M51 — nothing reads it
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
  /** The HTTP status code to return. */
  status: number;
  /** The execution result (may contain errors). */
  result: GraphqlExecutionResult;
  /** Whether the result was streamed (reserved for M51b subscriptions). */
  streaming?: boolean;
}

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
   * @returns The execution outcome with HTTP status
   */
  execute(
    params: GraphqlRequestParams,
    requestContext?: IRequestContext,
  ): Promise<GraphqlExecutionOutcome>;

  /**
   * The endpoint path where GraphQL is served.
   */
  readonly endpoint: string;

  /**
   * Report the number of cached documents.
   */
  readonly cachedDocumentCount: number;
}
