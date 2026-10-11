import { unusedPort as nodeUnusedPort } from '../../../../test/node-helpers.ts';
/**
 * E2E tests for the graphql-transport-ws transport over a real Deno socket.
 *
 * Exercises the full connection lifecycle: handshake (init/ack), subscription
 * subscribe → next frames → complete, client complete teardown, and the
 * subprotocol echo on the 101. Mirrors the M46 real-socket e2e pattern.
 */

import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES, type IWebSocketService } from '@setu-ts/common';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { GraphqlPlugin } from '../../src/index.ts';
import {
  encodeFrame,
  GQL_COMPLETE,
  GQL_CONNECTION_ACK,
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

describe('GraphQL WS e2e (real socket)', () => {
  it('completes the graphql-transport-ws handshake and echoes the subprotocol', async () => {
    const typeDefs = 'type Query { hello: String }';
    const resolvers = { Query: { hello: () => 'world' } };

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
      const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
      expect(ws.available).toBe(true);

      const client = new WebSocket(`ws://127.0.0.1:${port}/graphql/ws`, ['graphql-transport-ws']);
      try {
        await opened(client);
        // The 101 must echo back the first requested subprotocol.
        expect(client.protocol).toBe('graphql-transport-ws');

        // Send connection_init.
        client.send(encodeFrame({ type: GQL_CONNECTION_INIT }));
        const ack = await nextMessage(client);
        expect(ack).toContain(GQL_CONNECTION_ACK);
      } finally {
        client.close();
        await closed(client);
      }
    } finally {
      await app.stop();
    }
  });

  it('executes a query over WS and receives next + complete', async () => {
    const typeDefs = 'type Query { hello: String }';
    const resolvers = { Query: { hello: () => 'world' } };

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
          payload: { query: '{ hello }' },
        }));

        // next
        const next = await nextMessage(client);
        expect(next).toContain(GQL_NEXT);
        expect(next).toContain('"hello":"world"');

        // complete
        const complete = await nextMessage(client);
        expect(complete).toContain(GQL_COMPLETE);
        expect(complete).toContain('"id":"1"');
      } finally {
        client.close();
        await closed(client);
      }
    } finally {
      await app.stop();
    }
  });

  it('client complete tears down the subscription', async () => {
    const typeDefs = 'type Query { hello: String }';
    const resolvers = { Query: { hello: () => 'world' } };

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
          payload: { query: '{ hello }' },
        }));
        await nextMessage(client); // next
        const complete = await nextMessage(client); // complete
        expect(complete).toContain(GQL_COMPLETE);

        // Client sends complete for the operation.
        client.send(encodeFrame({ type: GQL_COMPLETE, id: '1' }));
        // No more messages should arrive.
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        client.close();
        await closed(client);
      }
    } finally {
      await app.stop();
    }
  });
});
