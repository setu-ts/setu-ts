// A relative source import is intentional: Node and Bun load this same portable
// SDK source with native TypeScript stripping, while Deno uses the app import map.
import { createRealtimeClient, createSseClient } from '../../packages/sdk/src/index.ts';

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Drives both clients against the real server from Deno, Node, Bun, or workerd. */
export async function exerciseRealtimeClients(baseUrl: string): Promise<void> {
  const received: Array<{ readonly id?: string }> = [];
  let resolveEvents: (() => void) | undefined;
  const complete = new Promise<void>((resolve) => {
    resolveEvents = resolve;
  });
  const sse = createSseClient({
    url: `${baseUrl}/events`,
    headers: { authorization: 'Bearer smoke-token' },
    reconnect: { delayMs: 1, maxAttempts: 3 },
    onEvent: (event) => {
      received.push(event);
      if (received.length === 2) resolveEvents?.();
    },
  });
  await Promise.race([
    complete,
    wait(2_000).then(() => Promise.reject(new Error('SSE reconnect did not deliver two events.'))),
  ]);
  sse.close();
  if (received.some((event) => event.id === undefined)) {
    throw new Error('SSE heartbeat comment leaked as an event.');
  }
  const resume = await (await fetch(`${baseUrl}/resume`)).json() as {
    resumedWith: string | null;
  };
  if (resume.resumedWith !== received[0]?.id) {
    throw new Error('SSE reconnect did not send Last-Event-ID.');
  }

  let unexpectedlyClosed = false;
  let stopping = false;
  const socket = createRealtimeClient({
    url: baseUrl.replace(/^http/, 'ws') + '/ws/idle',
    parse: (data) => data,
    reconnect: { maxAttempts: 0 },
    onMessage: () => {},
    onStateChange: (state) => {
      if (state === 'closed' && !stopping) unexpectedlyClosed = true;
    },
  });
  await wait(140);
  stopping = true;
  socket.close();
  if (unexpectedlyClosed) {
    throw new Error(
      'Read-only WebSocket client did not survive the idle sweep.',
    );
  }
}

if (import.meta.main) {
  const nodeArgs = (globalThis as unknown as {
    readonly process?: { readonly argv?: string[] };
  })
    .process?.argv;
  const baseUrl = nodeArgs?.[2] ??
    (typeof Deno === 'undefined' ? undefined : Deno.args[0]);
  if (baseUrl === undefined) {
    throw new Error('Expected the realtime server URL.');
  }
  await exerciseRealtimeClients(baseUrl);
}
