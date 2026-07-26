/**
 * Request/Response bridge — maps kernel types to web types and back.
 *
 * @module
 * @since 0.1.0
 */

import type { HandlerResult } from '@hono-enterprise/common';
import type {
  IRequestContext,
  PopulateLoadContext,
  RouterLoadContext,
  SsrRequestHandler,
} from '../interfaces/index.ts';
import { applyDefaultLoadContext } from './load-context.ts';

/**
 * Bridges a kernel `IRequestContext` into a web `Request`, invokes the RR
 * handler, and maps the resulting web `Response` back onto `ctx.response`.
 *
 * Returns the `HandlerResult` for the route handler to return.
 *
 * @param ctx - The kernel request context
 * @param handler - The React Router request handler
 * @param createLoadContext - Factory for the per-request context provider
 * @param populateLoadContext - Optional hook adding app values to the context
 * @returns The `HandlerResult` produced by writing the response back
 * @since 0.1.0
 */
export async function bridgeRequestToRR(
  ctx: IRequestContext,
  handler: SsrRequestHandler,
  createLoadContext: () => RouterLoadContext,
  populateLoadContext?: PopulateLoadContext,
): Promise<HandlerResult> {
  // A fresh provider per request — React Router requires a real
  // `RouterContextProvider` instance and rejects anything else with a 500.
  const loadContext = createLoadContext();
  applyDefaultLoadContext(ctx, loadContext);
  populateLoadContext?.(ctx, loadContext);

  // Buffer the body only for methods that carry one. A web `Request` throws
  // when constructed with a GET/HEAD method and a non-null body, so the body
  // key is omitted entirely for those methods (SSR document loads are GET).
  const method = ctx.request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await ctx.request.bytes();

  const webRequest = new Request(ctx.request.url, {
    method: ctx.request.method,
    headers: ctx.request.headers,
    // ctx.signal is always live (M42) — lets RR abort loaders on disconnect.
    signal: ctx.signal,
    // Cast to the web `BodyInit`: a `Uint8Array` is a valid body, but its
    // `ArrayBufferLike` generic does not line up with `BufferSource` directly.
    ...(body !== undefined ? { body: body as BodyInit } : {}),
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
