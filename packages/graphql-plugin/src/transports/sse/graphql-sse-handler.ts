/**
 * GraphQL-over-SSE handler (distinct-connections mode).
 *
 * Built on M42's {@linkcode IResponse.stream()} — needs no other plugin.
 * Validation errors are sent INSIDE the accepted SSE stream as `next` events
 * (not as 400 responses) per the graphql-sse protocol.
 *
 * @module
 * @since 0.3.0
 */

import type {
  GraphqlOperationContext,
  GraphqlRequestParams,
  HandlerResult,
  IGraphqlService,
  IRequestContext,
  IResponse,
  RouteHandler,
} from '@hono-enterprise/common';
import type { ApqResolver, ApqResolveResult } from '../../apq/apq-resolver.ts';
import { encodeSseComment, encodeSseComplete, encodeSseEvent } from './sse-frame.ts';

/**
 * Create an SSE route handler supporting both GET and POST (C7).
 *
 * @param graphqlService - The GraphQL service
 * @param heartbeatMs - Milliseconds between keep-alive comments (0 disables)
 * @param apqResolver - Optional APQ resolver for persisted queries
 * @returns POST and GET route handlers
 */
export function createSseHandler(
  graphqlService: IGraphqlService,
  heartbeatMs: number = 0,
  apqResolver: ApqResolver | null = null,
): { post: RouteHandler; get: RouteHandler } {
  return {
    post: async (ctx: IRequestContext): Promise<HandlerResult> => {
      return await handleSseRequest(ctx, ctx.response, graphqlService, heartbeatMs, apqResolver);
    },
    get: async (ctx: IRequestContext): Promise<HandlerResult> => {
      return await handleSseGet(ctx, ctx.response, graphqlService, heartbeatMs, apqResolver);
    },
  };
}

async function handleSseRequest(
  ctx: IRequestContext,
  response: IResponse,
  graphqlService: IGraphqlService,
  heartbeatMs: number,
  apqResolver: ApqResolver | null,
): Promise<HandlerResult> {
  // Parse body
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    // Transport failure — buffered HTTP error
    response.status(400);
    response.header('Content-Type', 'application/json');
    const encoder = new TextEncoder();
    return response.send(encoder.encode(JSON.stringify({
      errors: [{ message: 'Invalid JSON body', extensions: { code: 'INVALID_JSON' } }],
    })));
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    response.status(400);
    response.header('Content-Type', 'application/json');
    const encoder = new TextEncoder();
    return response.send(encoder.encode(JSON.stringify({
      errors: [{
        message: 'Request body must be a JSON object',
        extensions: { code: 'BAD_REQUEST' },
      }],
    })));
  }

  const obj = body as Record<string, unknown>;

  // Build params — APQ may supply query
  const params: GraphqlRequestParams = {
    query: typeof obj.query === 'string' ? obj.query : '',
  };
  if (typeof obj.operationName === 'string') {
    params.operationName = obj.operationName;
  }
  if (
    typeof obj.variables === 'object' && obj.variables !== null && !Array.isArray(obj.variables)
  ) {
    params.variables = obj.variables as Record<string, unknown>;
  }
  if (typeof obj.extensions === 'object' && obj.extensions !== null) {
    params.extensions = obj.extensions as Record<string, unknown>;
  }

  // If query is missing and no extensions.persistedQuery, that is a transport failure
  if (!params.query && !params.extensions) {
    response.status(400);
    response.header('Content-Type', 'application/json');
    const encoder = new TextEncoder();
    return response.send(encoder.encode(JSON.stringify({
      errors: [{ message: 'Query is required', extensions: { code: 'BAD_REQUEST' } }],
    })));
  }

  // Resolve APQ before subscribe
  if (apqResolver !== null && !params.query) {
    const apqParams: { query?: string; extensions?: Record<string, unknown> } = {};
    if (typeof params.extensions === 'object' && params.extensions !== null) {
      apqParams.extensions = params.extensions;
    }
    const apqResult: ApqResolveResult = await apqResolver.resolve(apqParams);
    if (!apqResult.ok) {
      // APQ miss is a transport failure — not found means no document to subscribe
      response.status(400);
      response.header('Content-Type', 'application/json');
      const encoder = new TextEncoder();
      return response.send(encoder.encode(JSON.stringify({
        errors: [{ message: apqResult.message, extensions: { code: apqResult.code } }],
      })));
    }
    params.query = apqResult.query;
  }

  return streamSseResult(ctx, response, graphqlService, heartbeatMs, params);
}

async function handleSseGet(
  ctx: IRequestContext,
  response: IResponse,
  graphqlService: IGraphqlService,
  heartbeatMs: number,
  apqResolver: ApqResolver | null,
): Promise<HandlerResult> {
  const query = ctx.query.query;
  if (typeof query !== 'string' || query.length === 0) {
    // Transport failure — no query parameter
    response.status(400);
    response.header('Content-Type', 'application/json');
    const encoder = new TextEncoder();
    return response.send(encoder.encode(JSON.stringify({
      errors: [{ message: 'Query parameter is required', extensions: { code: 'BAD_REQUEST' } }],
    })));
  }

  const params: GraphqlRequestParams = { query };
  if (typeof ctx.query.operationName === 'string') {
    params.operationName = ctx.query.operationName;
  }
  if (typeof ctx.query.variables === 'string') {
    try {
      const parsed = JSON.parse(ctx.query.variables);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        params.variables = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed variables
    }
  }
  if (typeof ctx.query.extensions === 'string') {
    try {
      const parsed = JSON.parse(ctx.query.extensions);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        params.extensions = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed extensions
    }
  }

  // Resolve APQ if query is a hash-only request
  if (apqResolver !== null) {
    const apqParams: { query?: string; extensions?: Record<string, unknown> } = {};
    if (typeof params.query === 'string') apqParams.query = params.query;
    if (typeof params.extensions === 'object' && params.extensions !== null) {
      apqParams.extensions = params.extensions;
    }
    const apqResult: ApqResolveResult = await apqResolver.resolve(apqParams);
    if (!apqResult.ok) {
      response.status(400);
      response.header('Content-Type', 'application/json');
      const encoder = new TextEncoder();
      return response.send(encoder.encode(JSON.stringify({
        errors: [{ message: apqResult.message, extensions: { code: apqResult.code } }],
      })));
    }
    params.query = apqResult.query;
  }

  return streamSseResult(ctx, response, graphqlService, heartbeatMs, params);
}

/**
 * Shared SSE streaming logic for both POST and GET.
 */
async function streamSseResult(
  ctx: IRequestContext,
  response: IResponse,
  graphqlService: IGraphqlService,
  heartbeatMs: number,
  params: GraphqlRequestParams,
): Promise<HandlerResult> {
  // Build operation context (SSE path supplies requestContext)
  const context: GraphqlOperationContext = {
    requestContext: ctx,
  };

  // Call service.subscribe
  const outcome = await graphqlService.subscribe(params, context);

  // Open the stream — even for errors, the protocol requires the stream
  response.status(200);
  response.header('Content-Type', 'text/event-stream');
  response.header('Cache-Control', 'no-cache');
  response.header('Connection', 'keep-alive');

  const controller = new StreamController();

  // Handle outcome
  if (outcome.kind === 'error') {
    // GraphQL request error: emit inside stream as next + complete (C4)
    controller.enqueue(encodeSseEvent(outcome.result));
    controller.enqueue(encodeSseComplete());
    controller.close();
  } else if (outcome.kind === 'single') {
    // Query/mutation: one next, then complete
    controller.enqueue(encodeSseEvent(outcome.result));
    controller.enqueue(encodeSseComplete());
    controller.close();
  } else {
    // Stream: pump async iterable
    const pump = pumpStream(controller, outcome.stream, heartbeatMs, ctx.signal);
    // Fire-and-forget — the pump cleans up on abort/complete
    void pump;
  }

  return response.stream(controller.readable);
}

/**
 * Pump an async iterable into a stream controller with optional heartbeat.
 */
async function pumpStream(
  controller: StreamController,
  stream: AsyncIterable<unknown>,
  heartbeatMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(() => {
      if (signal?.aborted) {
        return;
      }
      controller.enqueue(encodeSseComment());
    }, heartbeatMs)
    : null;

  try {
    for await (const result of stream) {
      if (signal?.aborted) {
        break;
      }
      controller.enqueue(encodeSseEvent(result));
    }
    controller.enqueue(encodeSseComplete());
    controller.close();
  } catch (err) {
    controller.enqueue(encodeSseEvent({
      errors: [{ message: err instanceof Error ? err.message : 'Stream error' }],
    }));
    controller.enqueue(encodeSseComplete());
    controller.close();
  } finally {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
    }
  }
}

/**
 * Simple stream controller wrapping a ReadableStream.
 */
class StreamController {
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly readable: ReadableStream<Uint8Array>;

  constructor() {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
    this.readable = stream;
  }

  enqueue(chunk: Uint8Array): void {
    // NOTE: a hand-rolled `desiredSize` backpressure check here would silently
    // drop the second frame of every stream — a fresh `ReadableStream` (no
    // queuing strategy) has `desiredSize === 1`, so the FIRST enqueue drops it
    // to 0 and the `complete` frame that must follow a `next` is skipped. The
    // graphql-sse protocol REQUIRES that terminator, and native `EventSource`
    // never fires its listener without it. The stream's own backpressure is
    // applied via the underlying source, not by dropping protocol frames here.
    this.#controller.enqueue(chunk);
  }

  close(): void {
    this.#controller.close();
  }

  error(err: Error): void {
    this.#controller.error(err);
  }
}
