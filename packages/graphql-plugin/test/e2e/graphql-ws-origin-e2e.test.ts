import { unusedPort } from '../../../../test/node-helpers.ts';
/**
 * End to end: the GraphQL WebSocket transport inherits websocket-plugin's
 * handshake Origin check, so a page on another site cannot open
 * `/graphql/ws` with the user's cookies, while a same-origin client still
 * subscribes.
 */
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { GraphqlPlugin } from '../../src/index.ts';
import {
  encodeFrame,
  GQL_CONNECTION_INIT,
  GQL_SUBSCRIBE,
} from '../../src/transports/ws/ws-protocol.ts';

/**
 * Node's WebSocket with its non-standard init object. The headers ride in the
 * SECOND argument together with the protocols: a third argument is ignored,
 * which silently sends no `Origin` at all (measured 2026-11-05).
 */
const BrowserShapedWebSocket = WebSocket as unknown as new (
  url: string,
  init: { protocols: string[]; headers: Record<string, string> },
) => WebSocket;

async function serve() {
  let resolved = 0;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      WebSocketPlugin(),
      GraphqlPlugin({
        typeDefs: 'type Query { a: String } type Subscription { tick: Int }',
        resolvers: {
          Query: { a: () => 'x' },
          Subscription: {
            tick: {
              subscribe: () => {
                resolved++;
                return (async function* () {
                  yield { tick: 1 };
                })();
              },
            },
          },
        },
        subscriptions: {},
      }),
    ],
  });
  const port = await unusedPort();
  await app.start({ port });
  return { port, resolved: () => resolved, stop: () => app.stop() };
}

/** Opens a socket with the given Origin; resolves the first `next` payload or `'refused'`. */
function subscribe(port: number, origin: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = new BrowserShapedWebSocket(`ws://127.0.0.1:${port}/graphql/ws`, {
      protocols: ['graphql-transport-ws'],
      headers: { origin },
    });
    const timer = setTimeout(() => resolve('timeout'), 5000);
    const finish = (value: string) => {
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    socket.onerror = () => finish('refused');
    socket.onopen = () => socket.send(encodeFrame({ type: GQL_CONNECTION_INIT }));
    socket.onmessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as { type: string; payload?: unknown };
      if (frame.type === 'connection_ack') {
        socket.send(
          encodeFrame({
            type: GQL_SUBSCRIBE,
            id: '1',
            payload: { query: 'subscription { tick }' },
          }),
        );
      } else if (frame.type === 'next') {
        finish(JSON.stringify(frame.payload));
      }
    };
  });
}

describe('GraphQL over WebSocket refuses a cross-site handshake', () => {
  it('refuses another site and never runs the subscription', async () => {
    const server = await serve();
    try {
      expect(await subscribe(server.port, 'https://evil.example')).toBe('refused');
      expect(server.resolved()).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it('still subscribes from the same origin', async () => {
    const server = await serve();
    try {
      expect(await subscribe(server.port, `http://127.0.0.1:${server.port}`)).toBe(
        '{"data":{"tick":1}}',
      );
      expect(server.resolved()).toBe(1);
    } finally {
      await server.stop();
    }
  });
});
