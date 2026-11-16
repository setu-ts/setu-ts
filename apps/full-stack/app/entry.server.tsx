import { renderToReadableStream } from 'react-dom/server';
import { type EntryContext, isRouteErrorResponse, ServerRouter } from 'react-router';
import { CAPABILITIES, describeError, type ILogger, maskUrlUserinfo } from '@setu-ts/common';
import { getService } from '@setu-ts/react-router-plugin';

import type { AppLoadContext } from '~/lib/load-context.ts';
import { requestIdContext } from '~/server/context-keys.server.ts';

/**
 * Server entry.
 *
 * The response body is a ReadableStream, which the framework passes through
 * untouched — the kernel's IResponse.stream() carries it all the way to the
 * platform on every supported runtime.
 *
 * `await stream.allReady` then waits for every Suspense boundary before the
 * response is returned, so the HTML is complete and the status can still be
 * corrected to 500 if rendering failed late. That is the safe default, and it
 * means the document is NOT delivered incrementally. To stream shell-first,
 * drop the await for browser requests and keep it for crawlers, which need the
 * finished markup.
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
): Promise<Response> {
  let didError = false;

  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: request.signal,
      onError() {
        didError = true;
      },
    },
  );

  await stream.allReady;

  responseHeaders.set('Content-Type', 'text/html');
  return new Response(stream, {
    status: didError ? 500 : responseStatusCode,
    headers: responseHeaders,
  });
}

/**
 * Reports a loader, action or render failure once, to the structured log.
 *
 * An unknown URL is a 404, not a fault, and an aborted request is the client
 * leaving: neither is logged. Everything else goes through the application
 * logger instead of a raw stack trace on stderr.
 */
export function handleError(
  error: unknown,
  { request, context }: { request: Request; context: AppLoadContext },
): void {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error) && error.status === 404) return;
  getService<ILogger>(context, CAPABILITIES.LOGGER).error('SSR request failed', {
    path: new URL(request.url).pathname,
    requestId: context.get(requestIdContext),
    error: describeError(error),
    // Masked first, so a cut cannot split a URL before its userinfo is hidden;
    // then bounded like describeError's 8192, so one failing request cannot
    // write an unbounded log record.
    ...(error instanceof Error && error.stack
      ? { stack: maskUrlUserinfo(error.stack).slice(0, 8192) }
      : {}),
  });
}
