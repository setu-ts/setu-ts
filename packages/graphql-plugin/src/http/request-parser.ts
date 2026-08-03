/**
 * GraphQL request parsing — parse HTTP requests into GraphqlRequestParams.
 *
 * @module
 */

import type { GraphqlRequestParams } from '@hono-enterprise/common';

/**
 * Error codes for request parsing failures.
 */
export type GraphqlErrorCode =
  | 'INVALID_JSON'
  | 'BAD_REQUEST'
  | 'INVALID_VARIABLES'
  | 'INVALID_EXTENSIONS'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'OPERATION_RESOLUTION_FAILED'
  | 'METHOD_NOT_ALLOWED'
  | 'SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP'
  | 'BATCH_TOO_LARGE'
  | 'BATCHING_NOT_SUPPORTED';

/**
 * Parsing error with code.
 */
export interface ParseError extends Error {
  code: GraphqlErrorCode;
}

/**
 * Parse a POST request body into GraphQL parameters.
 *
 * @param body - The parsed JSON body
 * @returns GraphqlRequestParams
 * @throws {ParseError} If parsing fails
 */
export function parsePostBody(body: unknown): GraphqlRequestParams {
  // Body must be an object
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    const err = new Error('Request body must be a JSON object') as ParseError;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const obj = body as Record<string, unknown>;

  // query is required and must be a string
  if (typeof obj.query !== 'string') {
    const err = new Error('Query must be a string') as ParseError;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  // operationName is optional
  if (obj.operationName !== undefined && typeof obj.operationName !== 'string') {
    const err = new Error('Operation name must be a string') as ParseError;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  // variables must be a JSON object if present. `null` is permitted by the
  // spec and simply means "no variables"; an array is NOT, and is refused here
  // exactly as `parseGetQuery` refuses it — `typeof [] === 'object'`, so
  // without the array check the two entry points disagree and an array reaches
  // `execute` as the variable map.
  if (
    obj.variables !== undefined && obj.variables !== null &&
    (typeof obj.variables !== 'object' || Array.isArray(obj.variables))
  ) {
    const err = new Error('Variables must be a JSON object') as ParseError;
    err.code = 'INVALID_VARIABLES';
    throw err;
  }

  const result: GraphqlRequestParams = {
    query: obj.query,
  };

  if (typeof obj.operationName === 'string') {
    result.operationName = obj.operationName;
  }

  if (typeof obj.variables === 'object' && obj.variables !== null) {
    // Pass variables through verbatim (B2)
    result.variables = obj.variables as Record<string, unknown>;
  }

  // Parse extensions (object-or-absent)
  if (obj.extensions !== undefined) {
    if (
      typeof obj.extensions !== 'object' || obj.extensions === null || Array.isArray(obj.extensions)
    ) {
      const err = new Error('Extensions must be a JSON object') as ParseError;
      err.code = 'INVALID_EXTENSIONS';
      throw err;
    }
    result.extensions = obj.extensions as Record<string, unknown>;
  }

  return result;
}

/**
 * Parse a GET request query into GraphQL parameters.
 *
 * @param query - The query string params
 * @returns GraphqlRequestParams
 * @throws {ParseError} If parsing fails
 */
export function parseGetQuery(query: Record<string, string | string[]>): GraphqlRequestParams {
  const q = query.query;
  if (typeof q !== 'string') {
    const err = new Error('Query parameter is required') as ParseError;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const result: GraphqlRequestParams = {
    query: q,
  };

  if (typeof query.operationName === 'string') {
    result.operationName = query.operationName;
  }

  if (typeof query.variables === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(query.variables);
    } catch {
      const err = new Error('Invalid JSON in variables parameter') as ParseError;
      err.code = 'INVALID_VARIABLES';
      throw err;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const err = new Error('Variables must be a JSON object') as ParseError;
      err.code = 'INVALID_VARIABLES';
      throw err;
    }
    // Pass variables through verbatim (B2)
    result.variables = parsed as Record<string, unknown>;
  }

  return result;
}
