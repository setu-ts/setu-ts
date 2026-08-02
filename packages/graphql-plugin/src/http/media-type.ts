/**
 * Media type negotiation for GraphQL responses.
 *
 * @module
 */

/**
 * Content type for GraphQL JSON responses.
 */
export const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';

/**
 * Content type for GraphQL response media type.
 */
export const CONTENT_TYPE_GRAPHQL = 'application/graphql-response+json; charset=utf-8';

/**
 * Negotiate the response content type based on the Accept header.
 *
 * @param accept - The Accept header value
 * @returns 'graphql-response' if application/graphql-response+json is preferred, 'json' otherwise
 */
export function negotiateMediaType(accept: string | null): 'graphql-response' | 'json' {
  if (!accept) {
    return 'json';
  }

  // Check for application/graphql-response+json
  const normalized = accept.toLowerCase();
  if (normalized.includes('application/graphql-response+json')) {
    return 'graphql-response';
  }

  return 'json';
}
