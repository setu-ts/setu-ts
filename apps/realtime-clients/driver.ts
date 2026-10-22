// A relative source import, not `@setu-ts/sdk`: this file also runs under
// plain Node and Bun with type stripping, which do not resolve workspace paths.
import { createRealtimeClient, createSseClient } from '../../packages/sdk/src/index.ts';
import { IDLE_SOCKET_PATH, SMOKE_TOKEN } from './src/contract.ts';

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Checks that the SSE client reconnects with `Last-Event-ID` and skips heartbeats. */
async function checkSseClient(baseUrl: string): Promise<void> {
  const received: Array<{ readonly id?: string }> = [];
  let twoEventsArrived: () => void = () => {};
  const complete = new Promise<void>((resolve) => {
    twoEventsArrived = resolve;
  });
  const sse = createSseClient({
    url: `${baseUrl}/events`,
    headers: { authorization: `Bearer ${SMOKE_TOKEN}` },
    reconnect: { delayMs: 1, maxAttempts: 3 },
    onEvent: (event) => {
      received.push(event);
      if (received.length === 2) twoEventsArrived();
    },
  });
  await Promise.race([
    complete,
    wait(2_000).then(() => Promise.reject(new Error('SSE reconnect did not deliver two events.'))),
  ]);
  sse.close();

  if (received.some((event) => event.id === undefined)) {
    throw new Error('An SSE heartbeat comment leaked as an event.');
  }
  const { resumedWith } = (await (await fetch(`${baseUrl}/resume`)).json()) as {
    resumedWith: string | null;
  };
  if (resumedWith !== received[0]?.id) {
    throw new Error('The SSE reconnect did not send Last-Event-ID.');
  }
}

/** Checks that a read-only WebSocket client survives the server's idle sweep. */
async function checkIdleSocket(baseUrl: string): Promise<void> {
  let closedUnexpectedly = false;
  let stopping = false;
  const socket = createRealtimeClient({
    url: baseUrl.replace(/^http/, 'ws') + IDLE_SOCKET_PATH,
    parse: (data) => data,
    reconnect: { maxAttempts: 0 },
    onMessage: () => {},
    onStateChange: (state) => {
      if (state === 'closed' && !stopping) closedUnexpectedly = true;
    },
  });
  // Longer than the server's idle timeout, so only heartbeats keep the socket open.
  await wait(140);
  stopping = true;
  socket.close();
  if (closedUnexpectedly) {
    throw new Error('The read-only WebSocket client did not survive the idle sweep.');
  }
}

/** Drives both SDK clients against the real server, from Node, Bun or workerd. */
export async function exerciseRealtimeClients(baseUrl: string): Promise<void> {
  await checkSseClient(baseUrl);
  await checkIdleSocket(baseUrl);
}

if (import.meta.main) {
  const baseUrl = process.argv[2];
  if (baseUrl === undefined) throw new Error('Expected the realtime server URL.');
  await exerciseRealtimeClients(baseUrl);
}
