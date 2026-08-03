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
 * Error codes whose HTTP status is a **transport** decision rather than a
 * GraphQL one, so it survives the `application/json` status watershed.
 *
 * Everything else answers `200` under `application/json`, because a client
 * predating `application/graphql-response+json` reads a non-200 as a network
 * failure and never looks at the `errors` array.
 */
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'METHOD_NOT_ALLOWED',
  'SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP',
]);

/** Handler options shared by both verbs. */
interface HandlerOptions {
  graphiql: boolean;
  logger?: { info(message: string): void; error(message: string, error?: unknown): void };
}

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
  options: HandlerOptions,
): { post: RouteHandler; get: RouteHandler } {
  const postHandler: RouteHandler = async (ctx: IRequestContext) => {
    return await handleGraphqlPost(ctx, ctx.response, graphqlService, options);
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
  options: HandlerOptions,
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

  const outcome = await graphqlService.execute(params, ctx, 'POST');

  // Wire media-type negotiation (B1)
  const mediaType = negotiateMediaType(ctx.request.headers.get('accept'));
  return sendGraphqlResult(response, outcome, mediaType);
}

/**
 * Handle GET GraphQL requests.
 */
async function handleGraphqlGet(
  ctx: IRequestContext,
  response: IResponse,
  graphqlService: GraphqlService,
  path: string,
  options: HandlerOptions,
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

  const outcome = await graphqlService.execute(params, ctx, 'GET');

  // Wire media-type negotiation (B1)
  const mediaType = negotiateMediaType(ctx.request.headers.get('accept'));
  return sendGraphqlResult(response, outcome, mediaType);
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
 * Report whether an outcome carries a transport-level refusal, whose status
 * survives the `application/json` watershed.
 */
function hasTransportError(outcome: GraphqlExecutionOutcome): boolean {
  for (const e of outcome.result.errors ?? []) {
    const code = (e as { extensions?: { code?: unknown } }).extensions?.code;
    if (typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code)) {
      return true;
    }
  }
  return false;
}

/**
 * Send a GraphQL result response.
 *
 * Under `application/graphql-response+json` the outcome's status is used
 * verbatim. Under `application/json` every well-formed GraphQL request answers
 * `200` — only a transport refusal keeps its status. The rule is identical for
 * `POST` and `GET`; the verb never affects it.
 */
function sendGraphqlResult(
  response: IResponse,
  outcome: GraphqlExecutionOutcome,
  mediaType: 'json' | 'graphql-response',
): HandlerResult {
  const contentType = mediaType === 'graphql-response' ? CONTENT_TYPE_GRAPHQL : CONTENT_TYPE_JSON;
  const body = JSON.stringify(outcome.result);

  const transport = hasTransportError(outcome);
  const status = mediaType === 'graphql-response' || transport ? outcome.status : 200;

  response.status(status).header('Content-Type', contentType);
  // A `405` must advertise what IS allowed (RFC 9110 §15.5.6). The GraphQL
  // endpoint refuses a mutation over GET and accepts it over POST.
  if (outcome.status === 405) {
    response.header('Allow', 'POST');
  }
  return response.send(new TextEncoder().encode(body));
}
