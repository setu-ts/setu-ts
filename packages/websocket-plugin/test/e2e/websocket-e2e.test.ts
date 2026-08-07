/**
 * End-to-end WebSocket tests — a real kernel application bound to a real TCP
 * port, with real browser-grade `WebSocket` clients connecting to it.
 *
 * This is the milestone's proof that the upgrade path actually works rather
 * than that its fakes agree with each other: it exercises `Deno.upgradeWebSocket`
 * through `DenoHttpAdapter`, the plugin's upgrade router, the sink, the
 * connection registry, and rooms, over genuine sockets.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES, type IWebSocketService } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/index.ts';

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
function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), 5000);
    socket.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(String(event.data));
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
function freePort(): number {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

describe('WebSocket plugin (e2e, real sockets)', () => {
  it('echoes a message over a genuine WebSocket connection', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WebSocketPlugin()],
    });
    const port = freePort();
    await app.start({ port });

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws/echo', {
      onMessage: (conn, data) => {
        conn.send(`echo:${String(data)}`);
      },
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/echo`);
    try {
      await opened(client);
      const reply = nextMessage(client);
      client.send('hello');
      expect(await reply).toBe('echo:hello');
      expect(ws.connectionCount).toBe(1);
    } finally {
      client.close();
      await closed(client);
      await app.stop();
    }
  });

  it('broadcasts to a room and honors the except option', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WebSocketPlugin()],
    });
    const port = freePort();
    await app.start({ port });

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws/chat', {
      onOpen: (conn, context) => {
        // Reads a query parameter and per-connection state on the real path.
        const room = context.query.room ?? 'lobby';
        conn.data.set('room', room);
        ws.room(room).add(conn);
      },
      onMessage: (conn, data) => {
        const room = conn.data.get('room') as string;
        ws.room(room).broadcast(`${conn.id.slice(0, 4)}:${String(data)}`, { except: conn });
      },
    });

    const alice = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?room=general`);
    const bob = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?room=general`);
    try {
      await Promise.all([opened(alice), opened(bob)]);
      expect(ws.connectionCount).toBe(2);
      expect(ws.roomCount).toBe(1);

      const heardByBob = nextMessage(bob);
      let aliceHeardOwnEcho = false;
      alice.onmessage = () => {
        aliceHeardOwnEcho = true;
      };

      alice.send('hi everyone');
      expect(await heardByBob).toMatch(/:hi everyone$/);
      expect(aliceHeardOwnEcho).toBe(false);
    } finally {
      alice.close();
      bob.close();
      await Promise.all([closed(alice), closed(bob)]);
      await app.stop();
    }
  });

  it('leaves non-WebSocket routes untouched on the same server', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WebSocketPlugin()],
    });
    const port = freePort();
    app.router.get('/health', (ctx) => ctx.response.json({ ok: true }));
    await app.start({ port });

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws', { onMessage: (conn, data) => conn.send(data) });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await app.stop();
    }
  });

  it('refuses an upgrade on an unregistered path without killing the server', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WebSocketPlugin()],
    });
    const port = freePort();
    await app.start({ port });

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws/known', { onMessage: (conn, data) => conn.send(data) });

    const stray = new WebSocket(`ws://127.0.0.1:${port}/ws/unknown`);
    try {
      // No route matches, so the router falls through to the HTTP pipeline,
      // which answers 404 — the handshake never completes.
      await expect(opened(stray)).rejects.toThrow();

      // The server is still healthy afterwards.
      const good = new WebSocket(`ws://127.0.0.1:${port}/ws/known`);
      await opened(good);
      const reply = nextMessage(good);
      good.send('still alive');
      expect(await reply).toBe('still alive');
      good.close();
      await closed(good);
    } finally {
      await app.stop();
    }
  });

  it('refuses an upgrade once maxConnections is reached', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WebSocketPlugin({ maxConnections: 1 })],
    });
    const port = freePort();
    await app.start({ port });

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    ws.route('/ws/limited', { onMessage: (conn, data) => conn.send(data) });

    const first = new WebSocket(`ws://127.0.0.1:${port}/ws/limited`);
    try {
      await opened(first);
      expect(ws.connectionCount).toBe(1);

      const second = new WebSocket(`ws://127.0.0.1:${port}/ws/limited`);
      await expect(opened(second)).rejects.toThrow();
      expect(ws.connectionCount).toBe(1);
    } finally {
      first.close();
      await closed(first);
      await app.stop();
    }
  });
});
