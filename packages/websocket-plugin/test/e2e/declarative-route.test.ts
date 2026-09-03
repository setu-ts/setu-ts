/**
 * End-to-end proof of the M86 §7 verification bar: the X13 collaboration board
 * route — one WebSocket room with a guarded upgrade — is expressible with NONE
 * of what X13's collaboration plugin had to write. X13 needed an `IPlugin`
 * (name, version, `register`) to host one route; it wrote the path string
 * twice, once in a hand-rolled equality match and once in the actual `route()`
 * call; and it installed that match as APPLICATION-WIDE middleware, running on
 * every request in the application, because no route-scoped guard existed.
 *
 * This file registers the same room route ENTIRELY through
 * `WebSocketPluginOptions.routes` with a route-scoped guard, and asserts the
 * three losses:
 *
 *   1. NO `IPlugin` wrapper — the application's plugin list is exactly the two
 *      first-party plugins (`runtime`, `websocket-plugin`); the collaboration
 *      feature contributes a single entry in the plugin's `routes` option.
 *   2. NO second copy of the path string — the path is declared ONCE and every
 *      consumer (the route entry, the guard, the client URLs) reads that one
 *      constant; no `route()` call and no path-matching function exists
 *      anywhere in this file. An upgrade succeeding through the options arm
 *      alone is what proves the single declaration is the operative
 *      registration, and a prefix-adjacent path being refused proves there is
 *      no second, hand-matched copy of the path logic.
 *   3. NO application-wide middleware — the application is created from
 *      plugins alone (there is no `app.middleware.add` call in this file) and
 *      the guard ran only for the board route's own upgrades.
 *
 * Everything is driven through a REAL kernel application bound to a real
 * 127.0.0.1 port with real RFC 6455 handshakes — not a hand-built plugin
 * context: a guarded connection completes the handshake and exchanges board
 * strokes in both directions; a connection without the board token is refused,
 * and a raw TCP socket reads the guard's `HTTP/1.1 401` status line off the
 * wire.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  CAPABILITIES,
  type IPlugin,
  type IWebSocketService,
  type RegistryFactory,
} from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/index.ts';
// The plugin's own option/definition types — deliberately NOT re-exported from
// `common`.
import type { WebSocketPluginOptions, WebSocketRouteDefinition } from '../../src/index.ts';

/** The board route's path. Declared EXACTLY once — see assertion 2 above. */
const BOARD_PATH = '/ws/board';
/** The shared board key the route-scoped guard checks. */
const BOARD_TOKEN = 'board-shared-key';
/** The room both collaborators join, via the query string. */
const ROOM = 'alpha';

/** Bounded wait for every socket event, so a failure fails instead of hanging. */
const TIMEOUT_MS = 5000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the route's guard observed about one upgrade attempt. */
interface GuardObservation {
  readonly path: string;
  readonly token: string | undefined;
}

/** The application under test plus the witnesses its assertions read. */
interface BoardApp {
  readonly app: IKernelApplication;
  readonly plugins: IPlugin[];
  readonly guardRuns: GuardObservation[];
}

// ---------------------------------------------------------------------------
// Client-side helpers (the same proven pattern as websocket-e2e.test.ts)
// ---------------------------------------------------------------------------

/** Resolves once the socket is open, or rejects on error/timeout. */
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for open')), TIMEOUT_MS);
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
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), TIMEOUT_MS);
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

/** Picks a free ephemeral port on 127.0.0.1 by binding and immediately releasing one. */
function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/**
 * Performs one raw RFC 6455 upgrade handshake over a real TCP connection and
 * returns the response's status line — the wire truth of what the guard
 * decided. The socket is closed before returning; no frames are exchanged.
 */
async function rawUpgradeStatusLine(port: number, pathWithQuery: string): Promise<string> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  try {
    const request = [
      `GET ${pathWithQuery} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
    ].join('\r\n');
    await conn.write(encoder.encode(request + '\r\n\r\n'));

    // Read the response head and nothing more — the status line is all a
    // refusal needs.
    let head = '';
    for (;;) {
      const chunk = new Uint8Array(4096);
      const read = await conn.read(chunk);
      if (read === null) {
        throw new Error('connection closed before the handshake response completed');
      }
      head += decoder.decode(chunk.subarray(0, read), { stream: true });
      const end = head.indexOf('\r\n\r\n');
      if (end !== -1) {
        return head.slice(0, end).split('\r\n')[0] ?? '';
      }
    }
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// The application under test
// ---------------------------------------------------------------------------

/**
 * Builds the real application: exactly TWO first-party plugins, the board room
 * declared ONLY through the plugin's `routes` option. The entry uses the
 * factory arm — the designed declarative form for handlers that need a
 * resolved capability — so the room handlers reach the service through the
 * registry the plugin hands them, with no second registration site and no
 * application-authored plugin anywhere.
 */
function buildBoardApp(): BoardApp {
  const guardRuns: GuardObservation[] = [];

  const boardRoute: RegistryFactory<WebSocketRouteDefinition> = (services) => {
    const sockets = services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    return {
      path: BOARD_PATH,
      handlers: {
        onOpen: (conn, context) => {
          const room = context.query.room ?? 'lobby';
          conn.data.set('room', room);
          sockets.room(room).add(conn);
        },
        onMessage: (conn, data) => {
          const room = conn.data.get('room');
          if (typeof room === 'string') {
            sockets.room(room).broadcast(String(data), { except: conn });
          }
        },
      },
      options: {
        guards: [
          (context) => {
            guardRuns.push({ path: context.path, token: context.query.token });
            return context.query.token === BOARD_TOKEN ? true : { status: 401 };
          },
        ],
      },
    };
  };

  const options: WebSocketPluginOptions = { routes: [boardRoute] };
  const plugins: IPlugin[] = [RuntimePlugin(), WebSocketPlugin(options)];
  const app = createApplication({ plugins });
  return { app, plugins, guardRuns };
}

// ---------------------------------------------------------------------------
// The e2e
// ---------------------------------------------------------------------------

describe('X13 declarative board route (e2e, real sockets)', () => {
  it('serves the guarded room from the routes option alone — no plugin wrapper, no duplicated path, no global middleware', async () => {
    const { app, plugins, guardRuns } = buildBoardApp();
    const port = freePort();
    await app.start({ port });

    // The service is read after start for the counts below; the route itself
    // was registered by the declarative arm during plugin registration, before
    // any client connects.
    const sockets = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    // Assertion 1 — no IPlugin wrapper: the whole application is exactly the
    // two first-party plugins; the collaboration feature contributed none.
    expect(plugins).toHaveLength(2);
    expect(plugins.map((plugin) => plugin.name).sort()).toEqual([
      'runtime',
      'websocket-plugin',
    ]);

    const alice = new WebSocket(
      `ws://127.0.0.1:${port}${BOARD_PATH}?room=${ROOM}&token=${BOARD_TOKEN}`,
    );
    const bob = new WebSocket(
      `ws://127.0.0.1:${port}${BOARD_PATH}?room=${ROOM}&token=${BOARD_TOKEN}`,
    );
    try {
      // The guarded upgrade completes over real sockets — the guard returned
      // `true` and the options arm's registration is what accepted it.
      await Promise.all([opened(alice), opened(bob)]);
      expect(sockets.connectionCount).toBe(2);
      expect(sockets.peek(ROOM)?.size).toBe(2);

      // Assertion 2 — no second copy of the path: the ONE constant is what the
      // route table matched and what the guard observed. There is no `route()`
      // call and no path-matching function in this file, so the single
      // declaration is the sole mechanism that could have registered it.
      //
      // Assertion 3 — no application-wide middleware: the guard ran exactly
      // once per board-route upgrade (twice for two upgrades) and for nothing
      // else — application-wide middleware would have run per REQUEST.
      expect(guardRuns).toEqual([
        { path: BOARD_PATH, token: BOARD_TOKEN },
        { path: BOARD_PATH, token: BOARD_TOKEN },
      ]);

      // The collaboration itself, over the real sockets: strokes fan out to
      // the room and the sender is excluded.
      const stroke = '{"t":"stroke","x":12,"y":30}';
      const heardByBob = nextMessage(bob);
      let aliceHeardOwnEcho = false;
      alice.onmessage = () => {
        aliceHeardOwnEcho = true;
      };
      alice.send(stroke);
      expect(await heardByBob).toBe(stroke);
      expect(aliceHeardOwnEcho).toBe(false);

      const reply = '{"t":"stroke","x":44,"y":2}';
      const heardByAlice = nextMessage(alice);
      bob.send(reply);
      expect(await heardByAlice).toBe(reply);
    } finally {
      alice.close();
      bob.close();
      await Promise.all([closed(alice), closed(bob)]);
      await app.stop();
    }
  });

  it('refuses an upgrade without the board token — 401 on the wire, handshake never completes', async () => {
    const { app, guardRuns } = buildBoardApp();
    const port = freePort();
    await app.start({ port });
    const sockets = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    try {
      // Raw socket: the guard's refusal IS the response — read the status line
      // the wire actually carried.
      const statusLine = await rawUpgradeStatusLine(port, BOARD_PATH);
      expect(statusLine.startsWith('HTTP/1.1 401')).toBe(true);
      expect(sockets.connectionCount).toBe(0);

      // A browser-grade client with a WRONG token fails the same way: no
      // handshake, no connection.
      const stray = new WebSocket(
        `ws://127.0.0.1:${port}${BOARD_PATH}?room=${ROOM}&token=not-the-key`,
      );
      await expect(opened(stray)).rejects.toThrow();
      expect(sockets.connectionCount).toBe(0);

      // Exact-path scoping: a prefix-adjacent path is not the declared route —
      // it falls through to 404 rather than being accepted by some second,
      // hand-matched copy of the path logic. The guard never ran for it.
      const adjacent = new WebSocket(
        `ws://127.0.0.1:${port}${BOARD_PATH}-extra?room=${ROOM}&token=${BOARD_TOKEN}`,
      );
      await expect(opened(adjacent)).rejects.toThrow();

      // Route-scoped, not application-wide: the guard saw exactly the two
      // upgrades that matched the route — the raw one (no token at all) and
      // the wrong-token one — and nothing for the adjacent path.
      expect(guardRuns.map((run) => run.token)).toEqual([undefined, 'not-the-key']);

      // The server is healthy after the refusals: a properly tokened client is
      // still accepted through the same declarative route.
      const valid = new WebSocket(
        `ws://127.0.0.1:${port}${BOARD_PATH}?room=${ROOM}&token=${BOARD_TOKEN}`,
      );
      await opened(valid);
      expect(sockets.connectionCount).toBe(1);
      expect(sockets.peek(ROOM)?.size).toBe(1);
      valid.close();
      await closed(valid);
    } finally {
      await app.stop();
    }
  });
});
