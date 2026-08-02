/**
 * GraphQL HTTP handler — route handler for POST and GET.
 *
 * @module
 */

import type {
  GraphqlExecutionOutcome,
  HandlerResult,
  IRequestContext,
  IResponse,
  RouteHandler,
} from '@hono-enterprise/common';
import type { GraphqlService } from '../services/graphql-service.ts';
import { CONTENT_TYPE_GRAPHQL, CONTENT_TYPE_JSON, negotiateMediaType } from './media-type.ts';
import type { ParseError } from './request-parser.ts';
import { parseGetQuery, parsePostBody } from './request-parser.ts';
import { graphiqlHtml } from '../ui/graphiql.ts';

/**
 * Create a GraphQL route handler.
 *
 * @param graphqlService - The GraphQL service
 * @param path - The endpoint path
 * @param options - Handler options
 * @returns POST and GET route handlers
 */
export function createGraphqlHandler(
  graphqlService: GraphqlService,
  path: string,
  options: {
    graphiql: boolean;
    logger?: { info(message: string): void; error(message: string, error?: unknown): void };
  },
): { post: RouteHandler; get: RouteHandler } {
  const postHandler: RouteHandler = async (ctx: IRequestContext) => {
    return await handleGraphqlPost(ctx, ctx.response, graphqlService, path, options);
  };

  const getHandler: RouteHandler = async (ctx: IRequestContext) => {
    return await handleGraphqlGet(ctx, ctx.response, graphqlService, path, options);
  };

  return { post: postHandler, get: getHandler };
}

/**
 * Handle POST GraphQL requests.
 */
async function handleGraphqlPost(
  ctx: IRequestContext,
  response: IResponse,
  graphqlService: GraphqlService,
  _path: string,
  options: {
    graphiql: boolean;
    logger?: { info(message: string): void; error(message: string, error?: unknown): void };
  },
): Promise<HandlerResult> {
  const { logger } = options;

  // Check content-type for POST
  const contentType = ctx.request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return sendGraphqlError(response, 415, {
      message: 'Unsupported media type. Expected application/json',
      extensions: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });
  }

  // Parse body
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch (e) {
    logger?.error('Failed to parse JSON body', e);
    return sendGraphqlError(response, 400, {
      message: 'Invalid JSON body',
      extensions: { code: 'INVALID_JSON' },
    });
  }

  // Parse request params
  let params: { query: string; operationName?: string; variables?: Record<string, unknown> };
  try {
    params = parsePostBody(body);
  } catch (e) {
    const err = e as ParseError;
    logger?.error('Failed to parse GraphQL request', err);
    return sendGraphqlError(response, 400, {
      message: err.message,
      extensions: { code: err.code },
    });
  }

  // Execute (pass method for B6 operation kind check)
  const outcome = await graphqlService.execute(params, ctx, 'POST');

  // Wire media-type negotiation (B1)
  const mediaType = negotiateMediaType(ctx.request.headers.get('accept'));
  return sendGraphqlResult(response, outcome, mediaType, true);
}

/**
 * Handle GET GraphQL requests.
 */
async function handleGraphqlGet(
  ctx: IRequestContext,
  response: IResponse,
  graphqlService: GraphqlService,
  path: string,
  options: {
    graphiql: boolean;
    logger?: { info(message: string): void; error(message: string, error?: unknown): void };
  },
): Promise<HandlerResult> {
  const { logger, graphiql } = options;

  const queryParam = ctx.query.query;

  // Check for GraphiQL request
  if (!queryParam) {
    const accept = ctx.request.headers.get('accept') ?? '';
    if (graphiql && accept.includes('text/html')) {
      // Serve GraphiQL page
      const html = graphiqlHtml({ endpoint: path, title: 'GraphiQL' });
      response.status(200).header('Content-Type', 'text/html; charset=utf-8');
      return response.send(new TextEncoder().encode(html));
    }

    // No query, no HTML -> bad request
    return sendGraphqlError(response, 400, {
      message: 'Query parameter is required',
      extensions: { code: 'BAD_REQUEST' },
    });
  }

  // Parse query params
  let params: { query: string; operationName?: string; variables?: Record<string, unknown> };
  try {
    params = parseGetQuery(ctx.query as Record<string, string | string[]>);
  } catch (e) {
    const err = e as ParseError;
    logger?.error('Failed to parse GraphQL request', err);
    return sendGraphqlError(response, 400, {
      message: err.message,
      extensions: { code: err.code },
    });
  }

  // Execute (pass method for B6 operation kind check - parse-based, handles comments too)
  const outcome = await graphqlService.execute(params, ctx, 'GET');

  // Wire media-type negotiation (B1)
  const mediaType = negotiateMediaType(ctx.request.headers.get('accept'));
  return sendGraphqlResult(response, outcome, mediaType, false);
}

/**
 * Send a GraphQL error response.
 */
function sendGraphqlError(
  response: IResponse,
  status: number,
  error: { message: string; extensions?: { code: string } },
): HandlerResult {
  const body = JSON.stringify({ errors: [error] });
  response.status(status).header('Content-Type', CONTENT_TYPE_JSON);
  return response.send(new TextEncoder().encode(body));
}

/**
 * Send a GraphQL result response.
 */
function sendGraphqlResult(
  response: IResponse,
  outcome: GraphqlExecutionOutcome,
  mediaType: 'json' | 'graphql-response',
  isPost: boolean,
): HandlerResult {
  const contentType = mediaType === 'graphql-response' ? CONTENT_TYPE_GRAPHQL : CONTENT_TYPE_JSON;

  const body = JSON.stringify(outcome.result);

  // B1: Status code watershed — under 'json' force 200 for well-formed GraphQL requests
  // (validation errors, execution errors), but preserve transport errors (405, 400 for subscription)
  // under 'graphql-response' use outcome.status for all cases
  let status: number;
  if (mediaType === 'graphql-response') {
    status = outcome.status;
  } else if (isPost && outcome.status === 200) {
    // Under 'json' media type, POST requests that succeed get 200 (even with validation errors)
    status = 200;
  } else {
    // Preserve transport-level status codes (405 for mutation-over-GET, 400 for subscription)
    status = outcome.status;
  }

  response.status(status).header('Content-Type', contentType);
  return response.send(new TextEncoder().encode(body));
}
