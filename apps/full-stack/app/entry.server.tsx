import { renderToReadableStream } from 'react-dom/server';
import { type EntryContext, ServerRouter } from 'react-router';

/**
 * Server entry.
 *
 * The response body is a ReadableStream, which the framework passes through
 * untouched — the kernel's `IResponse.stream()` carries it all the way to the
 * platform on every supported runtime. That is also why `smoke.ts` drives the
 * app with `app.fetch` rather than `app.inject()`, which buffers.
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
