/**
 * Cleartext HTTP/2 and HTTP/1.1 on one Node port (M139b §3.4).
 *
 * Node's `http2.createServer` answers only HTTP/2 in cleartext — `allowHTTP1`
 * applies over TLS alone (probed) — so a plain `http2: true` server would
 * silently refuse browsers, plain `fetch`, health probes and WebSocket
 * upgrades. This listener does what `Deno.serve` and Go 1.24's
 * `Protocols{HTTP1, UnencryptedHTTP2}` do: it reads the first bytes of each
 * connection and hands it to an HTTP/2 server when they are the HTTP/2
 * client preface, and to an HTTP/1.1 server at the first byte that is not.
 *
 * Four measured facts shape it:
 *
 * - On Node, the bytes read are `unshift`ed back and the socket ITSELF is
 *   handed to either server, left paused for HTTP/2: Node's HTTP/2 session
 *   reads a socket's buffered bytes on the tick after it takes the handle
 *   (`setupHandle`, nodejs/node#35475), and a `resume()` first would emit
 *   them to no listener. Measured under ghz, this hand-off costs nothing
 *   (connect-node behind it 9.1k rps, plain h2c 9.1-9.4k).
 * - Bun's `node:http2` does not read buffered bytes, so there the HTTP/2 side
 *   receives a JS `Duplex` that replays them ({@linkcode replayingDuplex}).
 *   That is slow on Node — every byte crosses a JS stream (1.5k rps against
 *   6.1k for the same app over TLS) — which is why Node does not use it.
 * - An HTTP/2 server fed a JS stream sees a wrapper socket with no peer, so on
 *   the replay path the client address is recorded per session (from the
 *   synchronous `session` event) and stamped on each request under
 *   {@linkcode PEER_ADDRESS}. On the Node path the socket reports its own.
 * - A socket with no `error` listener crashes the process when its client
 *   hangs up mid-write (EPIPE on Node, "Protocol error" on Bun). Every socket
 *   and every replay stream gets one.
 *
 * Reading raw sockets is a trust boundary: the preface read is bounded to 24
 * bytes and {@linkcode PREFACE_TIMEOUT_MS}, after which the socket is
 * destroyed.
 *
 * @module
 */
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { createServer as createHttp2Server, createSecureServer } from 'node:http2';
import type { Http2ServerRequest, Http2ServerResponse, Http2Session } from 'node:http2';
import { Duplex } from 'node:stream';

import { detectRuntime } from '../../detector/runtime-detector.ts';
import { PEER_ADDRESS } from './node-peer.ts';

/**
 * `node:http2`'s TLS server factory, re-exported so the adapter loads every
 * HTTP/2 builtin through this one lazily imported module.
 */
export { createSecureServer };

/** The HTTP/2 client connection preface (RFC 9113 §3.4). */
const PREFACE = new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

/**
 * How long a new connection may take to show whether it speaks HTTP/2. An
 * idle `node:http` connection is allowed far longer (`headersTimeout`, 60 s),
 * so this adds no exposure; a client that sends nothing is closed.
 */
export const PREFACE_TIMEOUT_MS = 10_000;

/** What the first bytes of a connection say about it. */
export type PrefaceVerdict = 'http1' | 'http2' | 'pending';

/**
 * Classifies the bytes read so far from a new connection.
 *
 * @param bytes - Everything received so far
 * @returns `http2` once all 24 preface bytes match, `http1` at the first byte
 *   that differs, `pending` while every byte so far matches
 */
export function classifyPreface(bytes: Uint8Array): PrefaceVerdict {
  const length = Math.min(bytes.length, PREFACE.length);
  for (let i = 0; i < length; i++) {
    if (bytes[i] !== PREFACE[i]) return 'http1';
  }
  return bytes.length >= PREFACE.length ? 'http2' : 'pending';
}

/**
 * Closes, gracefully, every HTTP/2 session a server holds when the returned
 * function runs. An HTTP/2 server's own `close()` only stops new connections:
 * a client that keeps its session open (connect-node and grpc-js both do)
 * would otherwise hold the listener past shutdown. `session.close()` sends
 * GOAWAY and lets streams in flight finish.
 *
 * @param server - Any `node:http2` server
 * @returns Closes the sessions open at the time of the call
 */
export function trackHttp2Sessions(server: {
  on(event: 'session', listener: (session: Http2Session) => void): unknown;
}): () => void {
  const sessions = new Set<Http2Session>();
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  return () => {
    for (const session of sessions) session.close();
  };
}

/** The request listener both inner servers share (node-server's `getRequestListener`). */
export type SharedRequestListener = (
  incoming: IncomingMessage | Http2ServerRequest,
  outgoing: ServerResponse | Http2ServerResponse,
) => unknown;

/** Options for {@linkcode createCleartextHttp2Server}. */
export interface CleartextHttp2Options {
  /** Overrides {@linkcode PREFACE_TIMEOUT_MS}; tests only. */
  readonly prefaceTimeoutMs?: number;
  /**
   * Hands HTTP/2 connections over through {@linkcode replayingDuplex} rather
   * than the socket itself. Defaults to `true` on Bun only; tests force both.
   */
  readonly replay?: boolean;
}

/**
 * The shared-port server: the outer TCP listener plus its two inner servers.
 * Shaped like the `serve()` handle the adapter already uses — `close()`, and
 * `on('upgrade')` for WebSocket support, which belongs to the HTTP/1.1 side.
 */
export class CleartextHttp2Server {
  readonly #outer: NetServer;
  readonly #http1: HttpServer;
  readonly #http2: ReturnType<typeof createHttp2Server>;
  readonly #closeSessions: () => void;

  constructor(outer: NetServer, http1: HttpServer, http2: ReturnType<typeof createHttp2Server>) {
    this.#outer = outer;
    this.#http1 = http1;
    this.#http2 = http2;
    this.#closeSessions = trackHttp2Sessions(http2);
  }

  /** The outer TCP server, for `listen`, `address` and bind errors. */
  get net(): NetServer {
    return this.#outer;
  }

  /**
   * The bound address, as `net.Server.address()` reports it.
   *
   * @returns The address, or `null` before binding
   */
  address(): ReturnType<NetServer['address']> {
    return this.#outer.address();
  }

  /**
   * Subscribes to the HTTP/1.1 server's `upgrade` event — the only server on
   * which a WebSocket handshake can arrive.
   *
   * @param event - Always `'upgrade'`
   * @param listener - The upgrade listener
   * @returns This server
   */
  on(event: 'upgrade', listener: (...args: never[]) => void): this {
    this.#http1.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Stops accepting connections, closes both inner servers, sends GOAWAY to
   * every open HTTP/2 session and closes idle HTTP/1.1 keep-alive connections.
   */
  close(): void {
    this.#outer.close();
    this.#http1.close();
    this.#http1.closeIdleConnections();
    this.#http2.close();
    this.#closeSessions();
  }
}

/**
 * Wraps a socket whose first bytes were already read as a `Duplex` that
 * replays them, for `node:http2`.
 *
 * @param socket - The accepted socket
 * @param head - The bytes read before the protocol was known
 * @returns The replaying stream
 * @internal Exported for its tests only.
 */
export function replayingDuplex(socket: Socket, head: Uint8Array): Duplex {
  const duplex = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk: Uint8Array, encoding, callback) {
      socket.write(chunk, encoding, callback);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(error, callback) {
      socket.destroy(error ?? undefined);
      callback(error);
    },
  });
  duplex.push(head);
  socket.on('data', (chunk: Uint8Array) => {
    if (!duplex.push(chunk)) socket.pause();
  });
  socket.on('end', () => duplex.push(null));
  socket.on('error', (error) => duplex.destroy(error));
  socket.on('close', () => duplex.destroy());
  // The HTTP/2 session reports stream errors here; the socket's own listener
  // already handles the transport, so this only keeps an error from crashing.
  duplex.on('error', () => undefined);
  return duplex;
}

/**
 * Creates the shared-port server. The caller binds it through
 * {@linkcode CleartextHttp2Server.net}.
 *
 * @param listener - The request listener both inner servers run
 * @param options - Test overrides
 * @returns The server
 */
export function createCleartextHttp2Server(
  listener: SharedRequestListener,
  options?: CleartextHttp2Options,
): CleartextHttp2Server {
  const timeoutMs = options?.prefaceTimeoutMs ?? PREFACE_TIMEOUT_MS;
  const replay = options?.replay ?? detectRuntime() === 'bun';
  const http1 = createHttpServer(listener);
  const peers = new WeakMap<Http2Session, string | undefined>();
  // Set immediately around the synchronous `emit('connection')` below; the
  // HTTP/2 server creates the session and emits `session` inside that call.
  let pendingPeer: string | undefined;
  const http2 = createHttp2Server((incoming, outgoing) => {
    // An unknown peer is stamped as `undefined`, which `peerAddressOf` reads
    // as "ask the socket".
    Object.defineProperty(incoming, PEER_ADDRESS, {
      value: peers.get(incoming.stream.session as Http2Session),
    });
    return listener(incoming, outgoing);
  });
  http2.on('session', (session) => {
    peers.set(session, pendingPeer);
  });

  const outer = createNetServer((socket) => {
    socket.on('error', () => undefined);
    let head = new Uint8Array(0);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    const onData = (chunk: Uint8Array): void => {
      const joined = new Uint8Array(head.length + chunk.length);
      joined.set(head);
      joined.set(chunk, head.length);
      head = joined;
      const verdict = classifyPreface(head);
      if (verdict === 'pending') return;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.pause();
      if (verdict === 'http1') {
        socket.unshift(head);
        http1.emit('connection', socket);
        socket.resume();
        return;
      }
      if (!replay) {
        // Stays paused: the session reads the unshifted bytes next tick.
        socket.unshift(head);
        http2.emit('connection', socket);
        return;
      }
      pendingPeer = socket.remoteAddress;
      try {
        http2.emit('connection', replayingDuplex(socket, head));
      } finally {
        pendingPeer = undefined;
      }
    };
    socket.on('data', onData);
    socket.on('close', () => clearTimeout(timer));
  });
  return new CleartextHttp2Server(outer, http1, http2);
}
