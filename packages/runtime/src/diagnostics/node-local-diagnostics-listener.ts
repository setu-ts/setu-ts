import { createServer, ServerResponse } from 'node:http';
import type { IncomingMessage, ServerOptions } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type {
  ILocalDiagnosticsListener,
  ILocalDiagnosticsListenerFactory,
  IRequest,
  LocalDiagnosticsListenerOptions,
} from '@setu-ts/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestWithTarget,
} from '../adapters/shared/fetch-mapping.ts';
import {
  INVALID_PORT_ERROR,
  LISTENER_ALREADY_ACTIVE_ERROR,
  SINGLETON_HEADER_NAMES,
  nativeFramingRefusal,
  refusalResponse,
} from './local-diagnostics-framing.ts';

/** The Node server surface used by the diagnostics listener. @internal */
export interface NodeListenerServer {
  maxRequestsPerSocket: number | null;
  listen(port: number, hostname: string): unknown;
  once(event: 'listening', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'listening', listener: () => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'clientError',
    listener: (error: Error & { code?: string }, socket: Socket) => void,
  ): unknown;
  on(
    event: 'connect' | 'upgrade',
    listener: (request: IncomingMessage, socket: Socket) => void,
  ): unknown;
  on(event: 'connection', listener: (socket: Socket) => void): unknown;
  on(
    event: 'checkContinue' | 'checkExpectation',
    listener: (request: IncomingMessage, response: ServerResponse) => void,
  ): unknown;
  address(): AddressInfo | string | null;
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections(): void;
}

/** Injectable HTTP creation and announcement seam; never exported by the package. @internal */
export interface NodeListenerHost {
  createServer(
    options: ServerOptions,
    listener: (request: IncomingMessage, response: ServerResponse) => void,
  ): NodeListenerServer;
  writeStderr?: (message: string) => void;
}

/**
 * Explicit parser and timeout budgets; maxConnections is the listener-owned
 * oldest-idle eviction cap, never assigned to Node's server.maxConnections.
 * @internal
 */
export const NODE_LISTENER_SERVER_OPTIONS: Readonly<{
  requireHostHeader: boolean;
  insecureHTTPParser: boolean;
  joinDuplicateHeaders: boolean;
  maxHeaderSize: number;
  headersTimeout: number;
  requestTimeout: number;
  keepAliveTimeout: number;
  connectionsCheckingInterval: number;
  maxRequestsPerSocket: number;
  maxConnections: number;
}> = Object.freeze({
  requireHostHeader: false,
  insecureHTTPParser: false,
  joinDuplicateHeaders: false,
  maxHeaderSize: 16_384,
  headersTimeout: 5_000,
  requestTimeout: 10_000,
  keepAliveTimeout: 5_000,
  connectionsCheckingInterval: 1_000,
  maxRequestsPerSocket: 0,
  maxConnections: 32,
});

/** One anonymous parser refusal, independent of the request and error text. @internal */
export const PARSER_REFUSAL_BYTES: string =
  'HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n';

/** Rejects framing before constructing a guarded framework request. */
function mapIncomingRequest(incoming: IncomingMessage, port: number): IRequest | null {
  if (incoming.url === undefined || !incoming.url.startsWith('/')) return null;
  const host = incoming.headers.host;
  if (host === undefined) return null;
  const seen = new Set<string>();
  const headers = new Headers();
  try {
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      const name = incoming.rawHeaders[index]!.toLowerCase();
      if (SINGLETON_HEADER_NAMES.includes(name)) {
        if (seen.has(name)) return null;
        seen.add(name);
      }
    }
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
    }
    const raw = new Request(`http://127.0.0.1:${port}/`, {
      method: incoming.method ?? 'GET',
      headers,
    });
    if (nativeFramingRefusal(raw) !== null) return null;
    return mapWebRequestWithTarget(
      raw,
      `http://${host}${incoming.url}`,
      incoming.socket.remoteAddress,
    );
  } catch {
    // Invalid native header/method spellings are anonymous protocol refusals.
    return null;
  }
}

/** Bounded, idempotent shutdown with exactly one factory-slot release. */
class NodeLocalDiagnosticsListener implements ILocalDiagnosticsListener {
  #closePromise: Promise<void> | null = null;
  #server: NodeListenerServer | null;
  readonly #onClosed: () => void;

  constructor(server: NodeListenerServer, onClosed: () => void) {
    this.#server = server;
    this.#onClosed = onClosed;
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#closePromise = promise;
    // Every later close returns above, so only this call can consume the server.
    const server = this.#server!;
    this.#server = null;
    let released = false;
    const finish = (): void => {
      if (released) return;
      released = true;
      this.#onClosed();
      resolve();
    };
    try {
      server.close(finish);
    } catch {
      finish();
    }
    try {
      server.closeAllConnections();
    } catch {
      // A failed destroy must not turn revocation into an application failure.
    }
    return promise;
  }
}

/** Node's private loopback diagnostics factory; one active or binding listener. @internal */
export class NodeLocalDiagnosticsListenerFactory implements ILocalDiagnosticsListenerFactory {
  #active: NodeLocalDiagnosticsListener | null = null;
  readonly #host: NodeListenerHost;

  constructor(
    host: NodeListenerHost = {
      createServer: (options, listener) => createServer(options, listener),
    },
  ) {
    this.#host = host;
  }

  async listen(options: LocalDiagnosticsListenerOptions): Promise<ILocalDiagnosticsListener> {
    if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) {
      throw new Error(INVALID_PORT_ERROR);
    }
    if (this.#active !== null) throw new Error(LISTENER_ALREADY_ACTIVE_ERROR);
    // Map insertion order is idle recency; a count protects pipelined responses
    // from becoming evictable while any response is still being served.
    const sockets = new Map<Socket, number>();
    const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
      const socket = request.socket;
      const busy = sockets.get(socket);
      if (busy !== undefined) {
        sockets.set(socket, busy + 1);
        const completed = (): void => {
          response.removeListener('finish', completed);
          response.removeListener('close', completed);
          const pending = sockets.get(socket);
          // The peer may have closed before this response completed.
          if (pending === undefined) return;
          sockets.delete(socket);
          sockets.set(socket, pending - 1);
        };
        response.once('finish', completed);
        response.once('close', completed);
      }
      void this.#handle(request, response, options);
    };
    const server = this.#host.createServer(NODE_LISTENER_SERVER_OPTIONS, handleRequest);
    server.on('connection', (socket) => {
      if (sockets.size >= NODE_LISTENER_SERVER_OPTIONS.maxConnections) {
        let oldestIdle: Socket | undefined;
        for (const [candidate, busy] of sockets) {
          if (busy === 0) {
            oldestIdle = candidate;
            break;
          }
        }
        if (oldestIdle === undefined) {
          socket.destroy();
          return;
        }
        sockets.delete(oldestIdle);
        oldestIdle.destroy();
      }
      sockets.set(socket, 0);
      socket.once('close', () => sockets.delete(socket));
    });
    // Suppress Node's automatic interim 100 and 417 replies: both Expect
    // events take exactly the same framing, mapping and response path.
    server.on('checkContinue', handleRequest);
    server.on('checkExpectation', handleRequest);
    server.maxRequestsPerSocket = NODE_LISTENER_SERVER_OPTIONS.maxRequestsPerSocket;
    // Node dispatches these outside the request callback and detaches their
    // parsers. Refuse them explicitly and close even a peer that never sends EOF.
    for (const event of ['connect', 'upgrade'] as const) {
      server.on(event, (request, socket) => {
        try {
          const response = new ServerResponse(request);
          response.shouldKeepAlive = false;
          response.assignSocket(socket);
          response.once('finish', () => socket.end(() => socket.destroy()));
          void this.#write(refusalResponse(400, 'invalid-request'), response);
        } catch {
          // A pipelined response may still own this socket. Never replace it
          // or expose the native assignment failure to the peer.
          socket.destroy();
        }
      });
    }
    server.on('clientError', (error, socket) => {
      if (!socket.writable || error.code === 'ECONNRESET') {
        socket.destroy();
        return;
      }
      try {
        socket.end(PARSER_REFUSAL_BYTES, () => socket.destroy());
      } catch {
        socket.destroy();
      }
    });
    let abortBinding: (() => void) | undefined;
    const listener = new NodeLocalDiagnosticsListener(server, () => {
      if (this.#active === listener) this.#active = null;
      abortBinding?.();
    });
    this.#active = listener;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          server.removeListener('error', failed);
          server.removeListener('listening', ready);
          abortBinding = undefined;
        };
        const ready = (): void => {
          cleanup();
          resolve();
        };
        const failed = (error: unknown): void => {
          cleanup();
          reject(error);
        };
        abortBinding = () =>
          failed(
            new Error('Local diagnostics listener: listener closed before binding completed.'),
          );
        server.once('listening', ready);
        server.once('error', failed);
        try {
          server.listen(options.port, '127.0.0.1');
        } catch (error) {
          failed(error);
        }
      });
      const address = server.address();
      if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
        throw new Error('Local diagnostics listener: listener did not bind 127.0.0.1.');
      }
      if (options.onListen !== undefined) {
        options.onListen({ hostname: '127.0.0.1', port: address.port });
      } else {
        const write =
          this.#host.writeStderr ??
          ((message: string): void => {
            process.stderr.write(message);
          });
        write(`Listening on http://127.0.0.1:${address.port}/\n`);
      }
      return listener;
    } catch (error) {
      await listener.close();
      throw error;
    }
  }

  /** Closes the currently active listener on application shutdown or failed startup. */
  closeActive(): Promise<void> {
    return this.#active === null ? Promise.resolve() : this.#active.close();
  }

  async #handle(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    options: LocalDiagnosticsListenerOptions,
  ): Promise<void> {
    let response: Response;
    try {
      const request = mapIncomingRequest(incoming, options.port);
      if (request === null) {
        response = refusalResponse(400, 'invalid-request');
      } else {
        const snapshot = (await options.handler(request)).snapshot();
        response = snapshot.streaming
          ? refusalResponse(503, 'unavailable')
          : mapSnapshotToWebResponse(snapshot);
      }
    } catch {
      response = refusalResponse(503, 'unavailable');
    }
    await this.#write(response, outgoing);
  }

  async #write(response: Response, outgoing: ServerResponse): Promise<void> {
    outgoing.on('error', () => outgoing.destroy());
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const headers = Object.fromEntries(response.headers);
      headers['content-length'] = String(bytes.byteLength);
      outgoing.writeHead(response.status, headers);
      outgoing.end(bytes);
    } catch {
      // Neither synchronous nor asynchronous write failures reflect their error text.
      outgoing.destroy();
    }
  }
}
