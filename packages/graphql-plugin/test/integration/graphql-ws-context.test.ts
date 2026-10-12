import { unusedPort as nodeUnusedPort } from '../../../../test/node-helpers.ts';
/**
 * Integration test for X6-6 (M70i): the resolver context differs exactly as
 * documented between the HTTP and WebSocket transports.
 *
 * - HTTP: `requestContext` present, `connection` absent.
 * - WS: `connection` present, `requestContext` absent.
 *
 * One resolver dumps its context keys; the test drives the same field over a
 * POST (HTTP) and over a real graphql-transport-ws subscription, then compares
 * the key sets. This is the behavioral pin for the §3.8 decision apart from
 * the alternative (synthesizing a dead `requestContext` over WS).
 */

import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { GraphqlPlugin } from '../../src/index.ts';
import {
  encodeFrame,
  GQL_CONNECTION_INIT,
  GQL_NEXT,
  GQL_SUBSCRIBE,
} from '../../src/transports/ws/ws-protocol.ts';

/** Resolves once the socket is open, or rejects on error/timeout. */
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for open')), 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('socket errored before opening'));
    };
  });
}

/** Resolves with the next inbound message. */
const messageQueues = new WeakMap<
  WebSocket,
  { values: string[]; waiter?: (value: string) => void }
>();
function nextMessage(socket: WebSocket): Promise<string> {
  let queue = messageQueues.get(socket);
  if (!queue) {
    queue = { values: [] };
    const inbox = queue;
    socket.addEventListener('message', (event) => {
      const value = String(event.data);
      if (inbox.waiter) {
        const accept = inbox.waiter;
        delete inbox.waiter;
        accept(value);
      } else inbox.values.push(value);
    });
    messageQueues.set(socket, queue);
  }
  const value = queue.values.shift();
  if (value !== undefined) return Promise.resolve(value);
  const inbox = queue;
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      delete inbox.waiter;
      reject(new Error('timed out waiting for message'));
    }, 5000);
    inbox.waiter = (message) => {
      clearTimeout(timer);
      accept(message);
    };
  });
}

/** Resolves once the socket has closed. */
function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.onclose = () => resolve();
  });
}

/** Picks a free ephemeral port by binding and immediately releasing one. */
function freePort(): Promise<number> {
  return nodeUnusedPort();
}

const typeDefs = `
  type Query { contextKeys: [String!] }
  type Subscription { contextKeys: [String!] }
`;

describe('GraphQL resolver context — HTTP vs WS (M70i X6-6)', () => {
  it('HTTP carries requestContext and omits connection', async () => {
    let captured: string[] | undefined;
    const resolvers = {
      Query: {
        contextKeys: (_s: unknown, _a: unknown, ctx: unknown) => {
          captured = Object.keys(ctx as Record<string, unknown>).sort();
          return captured;
        },
      },
    };

    const app = createApplication({
      plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} })],
    });
    await app.start({ port: 0 });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ contextKeys }' }),
      });
      expect(response.statusCode).toBe(200);
      // X6-6 HTTP shape: requestContext present, connection absent.
      expect(captured).toBeDefined();
      expect(captured).toContain('requestContext');
      expect(captured).not.toContain('connection');
    } finally {
      await app.stop();
    }
  });

  it('WS carries connection and omits requestContext', async () => {
    let captured: string[] | undefined;
    const resolvers = {
      Subscription: {
        contextKeys: {
          subscribe: (_s: unknown, _a: unknown, ctx: unknown) => {
            captured = Object.keys(ctx as Record<string, unknown>).sort();
            return (async function* () {
              yield { contextKeys: captured };
            })();
          },
        },
      },
    };

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        WebSocketPlugin(),
        GraphqlPlugin({ typeDefs, resolvers, subscriptions: {} }),
      ],
    });
    const port = await freePort();
    await app.start({ port });

    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}/graphql/ws`, ['graphql-transport-ws']);
      try {
        await opened(client);
        client.send(encodeFrame({ type: GQL_CONNECTION_INIT }));
        await nextMessage(client); // ack

        client.send(encodeFrame({
          type: GQL_SUBSCRIBE,
          id: '1',
          payload: { query: 'subscription { contextKeys }' },
        }));

        const next = await nextMessage(client);
        expect(next).toContain(GQL_NEXT);

        // X6-6 WS shape: connection present, requestContext absent.
        expect(captured).toBeDefined();
        expect(captured).toContain('connection');
        expect(captured).not.toContain('requestContext');

        // Drain the complete frame so the socket closes cleanly.
        await nextMessage(client);
      } finally {
        client.close();
        await closed(client);
      }
    } finally {
      await app.stop();
    }
  });
});
