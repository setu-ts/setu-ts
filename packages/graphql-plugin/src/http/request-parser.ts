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
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'OPERATION_RESOLUTION_FAILED'
  | 'METHOD_NOT_ALLOWED'
  | 'SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP';

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

  // variables must be an object if present
  if (obj.variables !== undefined && typeof obj.variables !== 'object') {
    const err = new Error('Variables must be an object') as ParseError;
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
    // Convert variables to string values
    const vars = obj.variables as Record<string, unknown>;
    result.variables = {};
    for (const [key, value] of Object.entries(vars)) {
      result.variables[key] = String(value);
    }
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
    try {
      const parsed = JSON.parse(query.variables);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        const err = new Error('Variables must be a JSON object') as ParseError;
        err.code = 'INVALID_VARIABLES';
        throw err;
      }
      result.variables = {};
      for (const [key, value] of Object.entries(parsed)) {
        result.variables[key] = String(value);
      }
    } catch (_e) {
      const err = new Error('Invalid JSON in variables parameter') as ParseError;
      err.code = 'INVALID_VARIABLES';
      throw err;
    }
  }

  return result;
}
