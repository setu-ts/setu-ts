/**
 * Recording fake `SsrRequestHandler`.
 *
 * @module
 * @since 0.1.0
 */

import type { SsrRequestHandler } from '../../src/interfaces/index.ts';

/**
 * Options for creating a fake RR handler.
 *
 * @since 0.1.0
 */
export interface FakeHandlerOptions {
  /** The web Response to return for every request. */
  response?: Response;
}

/**
 * Internal state tracked by the recording fake.
 *
 * @since 0.1.0
 */
interface FakeHandlerState {
  receivedRequests: Request[];
  receivedContexts: unknown[];
}

/**
 * Creates a fake `SsrRequestHandler` that records calls and returns a configured response.
 *
 * @param options - Configuration
 * @returns The fake handler + its state recorder
 * @since 0.1.0
 */
export function createFakeHandler(options?: FakeHandlerOptions): {
  handler: SsrRequestHandler;
  state: FakeHandlerState;
} {
  const state: FakeHandlerState = {
    receivedRequests: [],
    receivedContexts: [],
  };

  const defaultResponse = new Response('<html><body>Hello</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });

  // deno-lint-ignore require-await
  const handler: SsrRequestHandler = async (request, loadContext) => {
    state.receivedRequests.push(request);
    state.receivedContexts.push(loadContext);
    return options?.response ?? defaultResponse;
  };

  return { handler, state };
}

/**
 * Creates a streaming fake RR handler.
 *
 * @returns The fake handler
 * @since 0.1.0
 */
export function createStreamingFakeHandler(): SsrRequestHandler {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('<html><body>SSR streamed</body></html>'),
      );
      controller.close();
    },
  });

  // deno-lint-ignore require-await
  return async () =>
    new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
}
