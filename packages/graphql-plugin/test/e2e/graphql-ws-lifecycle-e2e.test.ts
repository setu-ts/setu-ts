/**
 * Real-socket lifecycle tests for the `graphql-transport-ws` transport.
 *
 * These cover the three things the rest of the suite reaches only through
 * fakes, and that a fake cannot settle:
 *
 *   1. Two subscriptions multiplexed on ONE socket — the per-id registry is
 *      where a hand-written protocol most easily goes wrong, and a single-
 *      subscription test cannot see a cross-talk bug.
 *   2. `onConnect` refusing a connection: the close code has to reach a real
 *      client, and a fake connection records whatever the handler asks for.
 *   3. `WebSocketRouteOptions.heartbeat` — the widening exists so that
 *      `WebSocketPlugin({ heartbeatMs })` cannot corrupt this route. Proving
 *      that needs the sweeper genuinely running, so the test carries a control
 *      connection on an ordinary route that MUST be swept.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import type { IWebSocketService } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { CAPABILITIES } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import type { WebSocketPluginOptions } from '@setu-ts/websocket-plugin';
import { GraphqlPlugin } from '../../src/index.ts';
import type { GraphqlWsTransportOptions, ResolverMap } from '../../src/index.ts';
import {
  decodeFrame,
  encodeFrame,
  GQL_COMPLETE,
  GQL_CONNECTION_ACK,
  GQL_CONNECTION_INIT,
  GQL_NEXT,
  GQL_SUBSCRIBE,
} from '../../src/transports/ws/ws-protocol.ts';

const typeDefs = `
  type Query { hello: String }
  type Subscription { ticks(label: String!, count: Int!): String! }
`;

const resolvers: ResolverMap = {
  Query: { hello: () => 'world' },
  Subscription: {
    ticks: {
      subscribe: (_source, args) =>
        (async function* () {
          for (let i = 0; i < Number(args.count); i++) {
            yield { ticks: `${args.label}-${i}` };
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
        })(),
    },
  },
};

/** Reserves a free port by binding one and releasing it. */
function freePort(): number {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

interface Harness {
  app: IKernelApplication;
  port: number;
}

async function startApp(options?: {
  ws?: WebSocketPluginOptions;
  graphqlWs?: GraphqlWsTransportOptions;
}): Promise<Harness> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      WebSocketPlugin(options?.ws),
      GraphqlPlugin({
        typeDefs,
        resolvers,
        subscriptions: { websocket: options?.graphqlWs ?? {}, sse: false },
      }),
    ],
  });
  const port = freePort();
  await app.start({ port });
  return { app, port };
}

/** Opens a socket and collects every inbound frame as raw text. */
function openSocket(url: string, protocols?: string | string[]): {
  socket: WebSocket;
  frames: string[];
  opened: Promise<void>;
  closed: Promise<CloseEvent>;
} {
  const socket = new WebSocket(url, protocols);
  const frames: string[] = [];
  socket.onmessage = (event) => void frames.push(String(event.data));
  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('socket error'));
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.onclose = (event) => resolve(event);
  });
  return { socket, frames, opened, closed };
}

/** Waits for a predicate, so nothing depends on a fixed sleep. */
async function until(predicate: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe('GraphQL WS lifecycle (real socket)', () => {
  it('multiplexes two subscriptions on one socket without cross-talk', async () => {
    const { app, port } = await startApp();
    const { socket, frames, opened, closed } = openSocket(
      `ws://127.0.0.1:${port}/graphql/ws`,
      ['graphql-transport-ws'],
    );
    try {
      await opened;
      socket.send(encodeFrame({ type: GQL_CONNECTION_INIT }));
      await until(() => frames.some((f) => f.includes(GQL_CONNECTION_ACK)));

      // Two operations, two ids, started back to back so their events interleave.
      socket.send(encodeFrame({
        type: GQL_SUBSCRIBE,
        id: 'a',
        payload: { query: 'subscription { ticks(label: "A", count: 3) }' },
      }));
      socket.send(encodeFrame({
        type: GQL_SUBSCRIBE,
        id: 'b',
        payload: { query: 'subscription { ticks(label: "B", count: 3) }' },
      }));

      const completes = () =>
        frames.map(decodeFrame).filter((f) => f?.type === GQL_COMPLETE).length;
      await until(() => completes() === 2, 8000);

      const decoded = frames.map(decodeFrame).filter((f) => f !== null);
      const nextFor = (id: string) =>
        decoded
          .filter((f) => f.type === GQL_NEXT && f.id === id)
          .map((f) => (f.payload as { data?: { ticks?: string } })?.data?.ticks);

      // Each id receives exactly its own operation's events, in order.
      expect(nextFor('a')).toEqual(['A-0', 'A-1', 'A-2']);
      expect(nextFor('b')).toEqual(['B-0', 'B-1', 'B-2']);
      // And each is terminated separately.
      expect(decoded.filter((f) => f.type === GQL_COMPLETE).map((f) => f.id).sort())
        .toEqual(['a', 'b']);
    } finally {
      socket.close();
      await closed;
      await app.stop();
    }
  });

  it('completing one subscription leaves the other streaming', async () => {
    const { app, port } = await startApp();
    const { socket, frames, opened, closed } = openSocket(
      `ws://127.0.0.1:${port}/graphql/ws`,
      ['graphql-transport-ws'],
    );
    try {
      await opened;
      socket.send(encodeFrame({ type: GQL_CONNECTION_INIT }));
      await until(() => frames.some((f) => f.includes(GQL_CONNECTION_ACK)));

      socket.send(encodeFrame({
        type: GQL_SUBSCRIBE,
        id: 'short',
        payload: { query: 'subscription { ticks(label: "S", count: 12) }' },
      }));
      socket.send(encodeFrame({
        type: GQL_SUBSCRIBE,
        id: 'long',
        payload: { query: 'subscription { ticks(label: "L", count: 12) }' },
      }));

      const seen = (id: string) =>
        frames.map(decodeFrame).filter((f) => f?.type === GQL_NEXT && f?.id === id).length;
      await until(() => seen('short') >= 2 && seen('long') >= 2, 8000);

      // Client completes ONE of them.
      socket.send(encodeFrame({ type: GQL_COMPLETE, id: 'short' }));
      const shortAtStop = seen('short');
      const longAtStop = seen('long');

      // The other must keep delivering.
      await until(() => seen('long') > longAtStop + 1, 8000);

      // And the completed one must go quiet — allowing the one frame that may
      // already have been in flight when `complete` was sent.
      expect(seen('short')).toBeLessThanOrEqual(shortAtStop + 1);
      expect(seen('long')).toBeGreaterThan(longAtStop + 1);
    } finally {
      socket.close();
      await closed;
      await app.stop();
    }
  });

  it('onConnect returning false closes a real client with 4403', async () => {
    const { app, port } = await startApp({
      graphqlWs: {
        onConnect: (info) => {
          // The protocol's auth channel: `connection_init`'s payload.
          return info.connectionParams?.token === 'good' ? undefined : false;
        },
      },
    });
    const refused = openSocket(`ws://127.0.0.1:${port}/graphql/ws`, ['graphql-transport-ws']);
    const accepted = openSocket(`ws://127.0.0.1:${port}/graphql/ws`, ['graphql-transport-ws']);
    try {
      await refused.opened;
      refused.socket.send(
        encodeFrame({ type: GQL_CONNECTION_INIT, payload: { token: 'wrong' } }),
      );
      const event = await refused.closed;
      expect(event.code).toBe(4403);
      // The refusal must land instead of an ack, not alongside one.
      expect(refused.frames.some((f) => f.includes(GQL_CONNECTION_ACK))).toBe(false);

      // Control: the same hook accepts a valid token, so 4403 is a decision
      // rather than the route being broken.
      await accepted.opened;
      accepted.socket.send(
        encodeFrame({ type: GQL_CONNECTION_INIT, payload: { token: 'good' } }),
      );
      await until(() => accepted.frames.some((f) => f.includes(GQL_CONNECTION_ACK)));
      expect(accepted.frames.some((f) => f.includes(GQL_CONNECTION_ACK))).toBe(true);
    } finally {
      accepted.socket.close();
      await accepted.closed;
      await app.stop();
    }
  });

  it('the shared heartbeat sweep never touches the GraphQL route', async () => {
    // The sweeper runs for real here: a fast tick and a short idle window, so
    // an ordinary route is swept several times during the test.
    const { app, port } = await startApp({
      ws: { heartbeatMs: 40, idleTimeoutMs: 120, heartbeatPayload: 'ping' },
    });

    // A control route registered WITHOUT the opt-out. Without it, this test
    // would pass just as happily if the sweeper never ran at all.
    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/plain', {});

    const control = openSocket(`ws://127.0.0.1:${port}/plain`);
    const graphql = openSocket(
      `ws://127.0.0.1:${port}/graphql/ws`,
      ['graphql-transport-ws'],
    );
    try {
      await control.opened;
      await graphql.opened;

      graphql.socket.send(encodeFrame({ type: GQL_CONNECTION_INIT }));
      await until(() => graphql.frames.some((f) => f.includes(GQL_CONNECTION_ACK)));
      // A listen-only subscriber: it sends nothing after subscribing, which is
      // exactly what `idleTimeoutMs` evicts on an ordinary route.
      graphql.socket.send(encodeFrame({
        type: GQL_SUBSCRIBE,
        id: '1',
        payload: { query: 'subscription { ticks(label: "T", count: 40) }' },
      }));

      // The control proves the sweeper is alive: it receives the raw payload,
      // and is then evicted for inbound silence with 1001.
      const controlClose = await Promise.race([
        control.closed,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      expect(control.frames).toContain('ping');
      expect(controlClose?.code).toBe(1001);

      // The GraphQL socket, swept over the same interval, is untouched: no raw
      // payload — which a conformant client would answer by closing 4400 — and
      // no idle eviction despite sending nothing.
      expect(graphql.frames).not.toContain('ping');
      expect(graphql.socket.readyState).toBe(WebSocket.OPEN);
      expect(graphql.frames.map(decodeFrame).some((f) => f?.type === GQL_NEXT)).toBe(true);
    } finally {
      control.socket.close();
      graphql.socket.close();
      await graphql.closed;
      await app.stop();
    }
  });
});
