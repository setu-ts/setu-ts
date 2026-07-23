/**
 * Request/Response bridge — maps kernel types to web types and back.
 *
 * @module
 * @since 0.1.0
 */

import type { HandlerResult, IRuntimeServices } from '@hono-enterprise/common';
import type {
  IRequestContext,
  LoadContextFunction,
  SsrRequestHandler,
} from '../interfaces/index.ts';
import { createDefaultLoadContext } from './load-context.ts';

/**
 * Bridges a kernel `IRequestContext` into a web `Request`, invokes the RR
 * handler, and maps the resulting web `Response` back onto `ctx.response`.
 *
 * Returns the `HandlerResult` for the route handler to return.
 *
 * @param ctx - The kernel request context
 * @param handler - The React Router request handler
 * @param getLoadContext - Optional custom loadContext builder
 * @param runtime - (Optional, unused) Retained for backward compatibility with tests
 * @returns The `HandlerResult` produced by writing the response back
 * @since 0.1.0
 */
export async function bridgeRequestToRR(
  ctx: IRequestContext,
  handler: SsrRequestHandler,
  getLoadContext: LoadContextFunction | undefined,
  _runtime?: IRuntimeServices,
): Promise<HandlerResult> {
  // Build the loadContext — default exposes services + user.
  const loadContext = (getLoadContext ?? createDefaultLoadContext)(ctx);

  // Buffer the body only for methods that carry one (not GET/HEAD).
  let requestBody: Uint8Array | undefined;
  const method = ctx.request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    requestBody = await ctx.request.bytes();
  }

  // Build web Request from kernel request + its signal.
  // deno-lint-ignore no-explicit-any
  const requestInit: any = {
    method: ctx.request.method,
    headers: ctx.request.headers,
  };

  // Only attach body for methods that support it (never for GET/HEAD).
  if (requestBody !== undefined) {
    requestInit.body = requestBody;
  }

  // Derive a web Request's signal from ctx.signal (always live).
  const signal = ctx.signal;

  const webRequest = new Request(ctx.request.url, {
    ...requestInit,
    signal,
  });

  // Invoke RR handler.
  const rrResponse = await handler(webRequest, loadContext);

  // Map web Response back onto ctx.response.
  return writeRRResponseToContext(ctx, rrResponse);
}

/**
 * Writes a web `Response` back onto the kernel `IRequestContext.response`.
 *
 * Handles status, headers (including `Set-Cookie` via `appendHeader`),
 * and body (streaming or buffered).
 *
 * @param ctx - The kernel request context
 * @param response - The web `Response` from RR
 * @returns The `HandlerResult`
 * @since 0.1.0
 */
async function writeRRResponseToContext(
  ctx: IRequestContext,
  response: Response,
): Promise<HandlerResult> {
  ctx.response.status(response.status);

  // Copy all headers. Set-Cookie uses appendHeader for multi-value;
  // other headers also use appendHeader so repeated header values survive.
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      // Multiple Set-Cookie values are already combined with `, ` by Headers.entries().
      // Use getSetCookie() for individual cookies below.
    } else {
      ctx.response.appendHeader(key, value);
    }
  }

  // Use getSetCookie() for individual Set-Cookie values.
  const setCookies = response.headers.getSetCookie();
  for (const cookie of setCookies) {
    ctx.response.appendHeader('Set-Cookie', cookie);
  }

  // Handle body: stream if ReadableStream, else buffer.
  if (response.body instanceof ReadableStream) {
    return ctx.response.stream(response.body);
  }

  // Buffer non-stream bodies.
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  return ctx.response.send(bytes);
}
