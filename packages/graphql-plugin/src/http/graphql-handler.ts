/**
 * GraphQL HTTP handler — route handler for POST and GET.
 *
 * @module
 */

import type {
  GraphqlExecutionOutcome,
  GraphqlRequestParams,
  HandlerResult,
  IRequestContext,
  IResponse,
  RouteHandler,
} from '@setu-ts/common';
import type { ApqResolver, ApqResolveResult } from '../apq/apq-resolver.ts';
import type { GraphqlService } from '../services/graphql-service.ts';
import { CONTENT_TYPE_GRAPHQL, CONTENT_TYPE_JSON, negotiateMediaType } from './media-type.ts';
import type { ParseError } from './request-parser.ts';
import { parseGetQuery } from './request-parser.ts';
import { graphiqlHtml } from '../ui/graphiql.ts';

/** Handler options shared by both verbs. */
interface HandlerOptions {
  graphiql: boolean;
  logger?: { info(message: string): void; error(message: string, error?: unknown): void };
  maxBatchSize: number;
  apqResolver: ApqResolver | null;
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
  const { logger, maxBatchSize, apqResolver } = options;

  // Negotiated once, up front: every response this handler can produce answers
  // in the media type the client asked for, transport failures included.
  const mediaType = negotiateMediaType(ctx.request.headers.get('accept'));

  // Check content-type for POST
  const contentType = ctx.request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return sendGraphqlError(response, 415, {
      message: 'Unsupported media type. Expected application/json',
      extensions: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    }, mediaType);
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
    }, mediaType);
  }

  // Batching: detect array body before parsePostBody
  if (Array.isArray(body)) {
    if (maxBatchSize <= 0) {
      return sendGraphqlError(response, 400, {
        message: 'Batching is not enabled',
        extensions: { code: 'BAD_REQUEST' },
      }, mediaType);
    }

    // Strict media type refuses batches
    if (mediaType === 'graphql-response') {
      return sendGraphqlError(response, 400, {
        message: 'Batching is not supported with application/graphql-response+json',
        extensions: { code: 'BATCHING_NOT_SUPPORTED' },
      }, mediaType);
    }

    if (body.length === 0) {
      return sendGraphqlError(response, 400, {
        message: 'Batch must contain at least one request',
        extensions: { code: 'BAD_REQUEST' },
      }, mediaType);
    }

    if (body.length > maxBatchSize) {
      return sendGraphqlError(response, 400, {
        message: `Batch size exceeds limit of ${maxBatchSize}`,
        extensions: { code: 'BATCH_TOO_LARGE' },
      }, mediaType);
    }

    // Execute each element concurrently — APQ resolves per-element
    const outcomes = await Promise.all(
      body.map(async (item: unknown) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          return {
            status: 400,
            result: { errors: [{ message: 'Batch item must be a JSON object' }] },
          };
        }
        const obj = item as Record<string, unknown>;

        // B1: Resolve APQ per-element before parsing
        let query = obj.query;
        const extensions = obj.extensions;
        if (apqResolver !== null) {
          const apqParams: { query?: string; extensions?: Record<string, unknown> } = {};
          if (typeof query === 'string') apqParams.query = query;
          if (typeof extensions === 'object' && extensions !== null) {
            apqParams.extensions = extensions as Record<string, unknown>;
          }
          const apqResult: ApqResolveResult = await apqResolver.resolve(apqParams);
          if (!apqResult.ok) {
            return {
              status: 400,
              result: {
                errors: [{ message: apqResult.message, extensions: { code: apqResult.code } }],
              },
            };
          }
          query = apqResult.query;
        }

        const params: GraphqlRequestParams = { query: query as string };
        if (typeof obj.operationName === 'string') {
          params.operationName = obj.operationName;
        }
        if (
          typeof obj.variables === 'object' && obj.variables !== null &&
          !Array.isArray(obj.variables)
        ) {
          params.variables = obj.variables as Record<string, unknown>;
        }
        if (typeof obj.extensions === 'object' && obj.extensions !== null) {
          params.extensions = obj.extensions as Record<string, unknown>;
        }
        return await graphqlService.execute(params, ctx, 'POST');
      }),
    );

    // Answer array of results
    const results = outcomes.map((outcome) => outcome.result);
    const encoder = new TextEncoder();
    response.status(200).header('Content-Type', 'application/json');
    return response.send(encoder.encode(JSON.stringify(results)));
  }

  // Must be an object (not array, already handled)
  if (typeof body !== 'object' || body === null) {
    return sendGraphqlError(response, 400, {
      message: 'Request body must be a JSON object',
      extensions: { code: 'BAD_REQUEST' },
    }, mediaType);
  }

  const obj = body as Record<string, unknown>;

  // B1 + B2: Resolve APQ BEFORE parsePostBody, allowing hash-only requests
  let query = obj.query;
  const extensions = obj.extensions;
  if (apqResolver != null) {
    const apqParams: { query?: string; extensions?: Record<string, unknown> } = {};
    if (typeof query === 'string') apqParams.query = query;
    if (typeof extensions === 'object' && extensions !== null) {
      apqParams.extensions = extensions as Record<string, unknown>;
    }
    const apqResult: ApqResolveResult = await apqResolver.resolve(apqParams);
    if (!apqResult.ok) {
      return sendGraphqlError(response, 400, {
        message: apqResult.message,
        extensions: { code: apqResult.code },
      }, mediaType);
    }
    query = apqResult.query;
  }

  // Now parse request params with the resolved query
  // Validate that query is present (required by GraphQL spec)
  if (typeof query !== 'string') {
    logger?.error('Query parameter is required');
    return sendGraphqlError(response, 400, {
      message: 'Query parameter is required',
      extensions: { code: 'BAD_REQUEST' },
    }, mediaType);
  }

  const params: GraphqlRequestParams = { query };
  if (typeof obj.operationName === 'string') {
    params.operationName = obj.operationName;
  }
  // Variables must be a JSON object (not array) — matches GET behavior
  if (obj.variables !== undefined) {
    if (
      obj.variables !== null && (typeof obj.variables !== 'object' || Array.isArray(obj.variables))
    ) {
      if (logger) {
        logger.error('Variables must be a JSON object');
      }
      return sendGraphqlError(response, 400, {
        message: 'Variables must be a JSON object',
        extensions: { code: 'INVALID_VARIABLES' },
      }, mediaType);
    }
    if (obj.variables !== null) {
      params.variables = obj.variables as Record<string, unknown>;
    }
  }
  if (typeof obj.extensions === 'object' && obj.extensions !== null) {
    params.extensions = obj.extensions as Record<string, unknown>;
  }

  const outcome = await graphqlService.execute(params, ctx, 'POST');

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
  const { logger, graphiql, apqResolver } = options;

  const mediaType = negotiateMediaType(ctx.request.headers.get('accept'));
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
    }, mediaType);
  }

  // Parse query params
  let params: {
    query: string;
    operationName?: string;
    variables?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  };
  try {
    params = parseGetQuery(ctx.query as Record<string, string | string[]>);
  } catch (e) {
    const err = e as ParseError;
    logger?.error('Failed to parse GraphQL request', err);
    return sendGraphqlError(response, 400, {
      message: err.message,
      extensions: { code: err.code },
    }, mediaType);
  }

  // C6: resolve APQ for GET so hash-only requests are served from cache.
  if (apqResolver !== null) {
    const apqParams: { query?: string; extensions?: Record<string, unknown> } = {};
    if (typeof params.query === 'string') apqParams.query = params.query;
    if (typeof params.extensions === 'object' && params.extensions !== null) {
      apqParams.extensions = params.extensions;
    }
    const apqResult = await apqResolver.resolve(apqParams);
    if (!apqResult.ok) {
      return sendGraphqlError(response, apqResult.status, {
        message: apqResult.message,
        extensions: { code: apqResult.code },
      }, mediaType);
    }
    params.query = apqResult.query;
  }

  const outcome = await graphqlService.execute(params, ctx, 'GET');

  return sendGraphqlResult(response, outcome, mediaType);
}

/**
 * Send a GraphQL error response for a failure raised before execution
 * (unsupported media type, malformed body, unusable parameters).
 *
 * These keep their HTTP status under both media types — they are transport
 * failures, not GraphQL results — but they still answer in the media type the
 * client negotiated, so a client that asked for
 * `application/graphql-response+json` is not handed `application/json`.
 */
function sendGraphqlError(
  response: IResponse,
  status: number,
  error: { message: string; extensions?: { code: string } },
  mediaType: 'json' | 'graphql-response',
): HandlerResult {
  const contentType = mediaType === 'graphql-response' ? CONTENT_TYPE_GRAPHQL : CONTENT_TYPE_JSON;
  const body = JSON.stringify({ errors: [error] });
  response.status(status).header('Content-Type', contentType);
  return response.send(new TextEncoder().encode(body));
}

/**
 * Send a GraphQL result response.
 *
 * Under `application/graphql-response+json` the outcome's status is used
 * verbatim. Under `application/json` every well-formed GraphQL request answers
 * `200` — a client predating the newer media type reads a non-200 as a network
 * failure and never looks at the `errors` array. The one exception is `405`,
 * which is a decision about the HTTP method rather than about GraphQL and which
 * carries an `Allow` header a client needs in order to retry correctly.
 *
 * The test is deliberately made on `outcome.status` alone. Deriving it from
 * error codes in the payload made the HTTP status depend on data the caller's
 * `formatError` hook can rewrite: a hook that reshaped errors dropped
 * `extensions`, and a refused mutation-over-GET answered `200`. The status must
 * not be a function of the response body.
 *
 * The rule is identical for `POST` and `GET`; the verb never affects it.
 */
function sendGraphqlResult(
  response: IResponse,
  outcome: GraphqlExecutionOutcome,
  mediaType: 'json' | 'graphql-response',
): HandlerResult {
  const contentType = mediaType === 'graphql-response' ? CONTENT_TYPE_GRAPHQL : CONTENT_TYPE_JSON;
  const body = JSON.stringify(outcome.result);

  const status = mediaType === 'graphql-response' || outcome.status === 405 ? outcome.status : 200;

  response.status(status).header('Content-Type', contentType);
  // A `405` must advertise what IS allowed (RFC 9110 §15.5.6). The GraphQL
  // endpoint refuses a mutation over GET and accepts it over POST.
  if (outcome.status === 405) {
    response.header('Allow', 'POST');
  }
  return response.send(new TextEncoder().encode(body));
}
