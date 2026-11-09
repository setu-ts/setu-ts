/**
 * Node HTTP server adapter — implements {@linkcode IHttpAdapter} using
 * `@hono/node-server` (Hono's platform serve layer).
 *
 * Uses an injectable {@linkcode NodeServeHost} interface that exposes
 * `serve({ fetch, port, hostname })` defaulting to a lazy import of
 * `@hono/node-server` (a regular dependency of this package, so a bare install
 * can serve on Node). This allows unit testing without a real Node
 * server. `serve()` is called with node-server's own defaults, which install
 * its lightweight `Request`/`Response` as globals — see the note on
 * `defaultNodeServeHost`.
 *
 * @module
 */

import type {
  IHttpAdapter,
  IRequest,
  IResponse,
  ResponseSnapshot,
  RpcFetchHandler,
  ServerHandle,
  WebSocketUpgradeIntent,
  WebSocketUpgradeRouter,
} from '@setu-ts/common';
import {
  isPromiseLike,
  OptionalDependencyUnavailableError,
  serializeError,
  upgradeIntentOf,
} from '@setu-ts/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../shared/fetch-mapping.ts';
import type { HttpAdapterOptions, Http2TlsOptions } from '../shared/adapter-options.ts';
import type { PEER_ADDRESS } from './node-peer.ts';
import { peerAddressOf } from './node-peer.ts';
import { UpgradeRouterStore } from '../shared/upgrade-router-store.ts';
import { ABNORMAL_CLOSURE } from '../shared/web-socket-transport.ts';
import type { NodeIncomingMessage, RawUpgradeSocket, WsModuleLike } from './node-ws-upgrader.ts';
import {
  asUpgradeEmitter,
  createUpgradeRequest,
  NodeUpgradeCoordinator,
  rejectRawUpgrade,
} from './node-ws-upgrader.ts';

// ---------------------------------------------------------------------------
// Host seam — what the adapter depends on
// ---------------------------------------------------------------------------

/**
 * The writable half of a Node exchange, as far as this adapter touches it:
 * `@hono/node-server` writes every response's status and headers through one
 * `writeHead(status, headers)` call.
 */
export interface NodeOutgoing {
  /**
   * Writes the status line and headers. Typed loosely so Node's own
   * `(status, statusMessage?, headers?)` overloads satisfy it.
   *
   * @param status - The response status
   * @param rest - An optional status message and the header record
   * @returns Whatever the underlying response returns
   */
  writeHead(status: number, ...rest: unknown[]): unknown;
  /**
   * Queues trailers to send after the body. Present on node-server's HTTP/2
   * response (`Http2ServerResponse`); the adapter writes trailers only on an
   * HTTP/2 request, where it is.
   *
   * @param headers - The trailer fields
   */
  addTrailers?(headers: Readonly<Record<string, string>>): void;
}

/**
 * The second argument `@hono/node-server` passes to a fetch callback.
 */
export interface NodeFetchEnv {
  /** The incoming request: its socket peer, its HTTP version, and any peer the listener recorded. */
  readonly incoming?: {
    readonly socket?: { readonly remoteAddress?: string | undefined };
    readonly httpVersion?: string;
    readonly [PEER_ADDRESS]?: string | undefined;
  };
  /** The Node response the reply is written to. */
  readonly outgoing?: NodeOutgoing;
}

/**
 * The fetch callback handed to {@linkcode NodeServeHost.serve}.
 *
 * @param request - The web request
 * @param env - node-server's per-request environment, when served by it
 * @returns The web response
 */
export type NodeFetchCallback = (
  request: Request,
  env?: NodeFetchEnv,
) => Response | Promise<Response>;

/**
 * Minimal interface covering the `@hono/node-server` `serve()` operation.
 * Inject this interface to test the adapter without a real Node server.
 */
export interface NodeServeHost {
  /**
   * Starts an HTTP server.
   *
   * @param options - Server options including `fetch`, `port`, `hostname`
   * @returns A promise resolving to the server only once its port is bound
   * @throws The native bind error when the port cannot be bound. Injected hosts
   * must also wait for binding before resolving.
   */
  serve(options: {
    // Spelled out rather than naming the internal NodeFetchCallback, so this
    // published interface references no type the barrel does not export.
    fetch: (
      request: Request,
      env?: {
        readonly incoming?: {
          readonly socket?: { readonly remoteAddress?: string | undefined };
          readonly httpVersion?: string;
        };
        readonly outgoing?: {
          writeHead(status: number, ...rest: unknown[]): unknown;
          addTrailers?(headers: Readonly<Record<string, string>>): void;
        };
      },
    ) => Response | Promise<Response>;
    port: number;
    hostname?: string;
    overrideGlobalObjects?: boolean;
    /**
     * Serve HTTP/2 beside HTTP/1.1 — `true` for cleartext on one port, TLS
     * material for ALPN. An injected host that ignores it serves HTTP/1.1.
     * @since 0.13.0
     */
    http2?: true | Http2TlsOptions;
  }): Promise<NodeServer>;
}

/**
 * Node.js HTTP server handle (returned by `@hono/node-server` `serve()`).
 *
 * `serve()` returns node-server's `ServerType`, which is a `node:http.Server`
 * (or its HTTP/2 equivalents) — so the `upgrade` event this adapter needs for
 * WebSocket support is available on it.
 */
export interface NodeServer {
  /**
   * Stops the server gracefully.
   */
  close(): void;
}

/**
 * Default Node serve host — lazy-loads `@hono/node-server` on first `serve()`
 * call. Throws a clear error if the package is not installed.
 *
 * @internal - Not exported from package index
 */
const defaultNodeServeHost: NodeServeHost = {
  serve: async (options) => {
    // Lazy import — only loads when listen() is actually called. Guarded in
    // the SAME function (AI_GUIDELINES §12.2) so a Worker bundling this file
    // does not fail at build time when the server adapter is absent.
    let mod: typeof import('@hono/node-server');
    try {
      mod = await import('@hono/node-server');
    } catch (error) {
      throw new OptionalDependencyUnavailableError('@hono/node-server', {
        requiredBy: '@setu-ts/runtime',
        cause: error,
      });
    }
    // node-server's own `Request`/`Response` are installed as globals, which
    // is its default and what every Hono-on-Node deployment already runs.
    //
    // This was previously opted out of with `overrideGlobalObjects: false`,
    // on the stated grounds that overriding "would corrupt the shared
    // mapping". That does not survive checking (M87): node-server builds the
    // inbound request with its own `newRequest()` UNCONDITIONALLY, so the
    // mapping receives the same lightweight facade either way. What the flag
    // actually decided was the class backing `new Response(...)` inside
    // `mapSnapshotToWebResponse` — and node-server serves a response through
    // its synchronous fast path only when the object carries that class's
    // internal cache symbol. Opting out therefore forced EVERY response onto
    // the slow path, and made the kernel's synchronous request path
    // unrewarded, since the fast path is gated on both conditions at once.
    const { http2, ...serveOptions } = options;
    if (http2 !== undefined) return serveHttp2(mod, serveOptions, http2);
    return new Promise<NodeServer>((resolve, reject) => {
      const server = mod.serve({ ...serveOptions }, ready);
      function ready(): void {
        server.removeListener('error', failed);
        resolve(server);
      }
      function failed(error: Error): void {
        // node-server wraps its listening callback. This failed, closing server
        // has no remaining listening consumers, so remove that wrapper too.
        server.removeAllListeners('listening');
        server.close();
        reject(error);
      }
      server.once('error', failed);
    });
  },
};

/** The `serve()` options the default host forwards, without `http2`. */
type ServeOptions = Omit<Parameters<NodeServeHost['serve']>[0], 'http2'>;

/**
 * Starts the HTTP/2 listener (M139b §3.4). The listener module, and with it
 * every `node:http2` builtin, is loaded only here — never by a Worker, never
 * by an application that did not ask for HTTP/2.
 *
 * - TLS: node-server's own `serve()` over `http2.createSecureServer` with
 *   `allowHTTP1`, so ALPN picks `h2` or HTTP/1.1 and `upgrade` still fires.
 * - Cleartext: the shared-port listener, running the same request listener
 *   `serve()` builds (`getRequestListener(fetch, { hostname })`).
 *
 * @param mod - The loaded `@hono/node-server`
 * @param options - The serve options
 * @param http2 - `true`, or the TLS material
 * @returns The server, once bound
 */
async function serveHttp2(
  mod: typeof import('@hono/node-server'),
  options: ServeOptions,
  http2: true | Http2TlsOptions,
): Promise<NodeServer> {
  const listener = await import('./node-http2-listener.ts');
  if (http2 !== true) {
    return new Promise<NodeServer>((resolve, reject) => {
      const server = mod.serve(
        {
          ...options,
          createServer: listener.createSecureServer,
          serverOptions: { key: http2.key, cert: http2.cert, allowHTTP1: true },
        },
        ready,
      );
      // `close()` must also end the HTTP/2 sessions clients keep open, or they
      // hold the listener past shutdown (see `trackHttp2Sessions`).
      const closeSessions = listener.trackHttp2Sessions(
        server as unknown as Parameters<typeof listener.trackHttp2Sessions>[0],
      );
      const closeServer = server.close.bind(server);
      server.close = ((callback?: (error?: Error) => void) => {
        closeSessions();
        return closeServer(callback);
      }) as typeof server.close;
      function ready(): void {
        server.removeListener('error', failed);
        resolve(server);
      }
      function failed(error: Error): void {
        server.removeAllListeners('listening');
        server.close();
        reject(error);
      }
      server.once('error', failed);
    });
  }
  const server = listener.createCleartextHttp2Server(
    mod.getRequestListener(options.fetch, {
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    }),
  );
  return new Promise<NodeServer>((resolve, reject) => {
    const failed = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.net.once('error', failed);
    server.net.listen(options.port, options.hostname, () => {
      server.net.removeListener('error', failed);
      resolve(server);
    });
  });
}

/**
 * Wraps a streaming body so the trailers are queued on the Node response
 * after its last chunk and before node-server ends the stream (M139b §3.3).
 * A rejecting trailers promise errors the stream, which resets it rather than
 * ending it as if it had succeeded.
 *
 * @param body - The response body
 * @param trailers - The trailers, resolving once the body ends
 * @param addTrailers - The Node response's `addTrailers`
 * @returns The wrapping stream
 */
export function streamWithTrailers(
  body: ReadableStream<Uint8Array>,
  trailers: Promise<Headers>,
  addTrailers: (headers: Readonly<Record<string, string>>) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (!next.done) {
        controller.enqueue(next.value);
        return;
      }
      const fields: Record<string, string> = {};
      (await trailers).forEach((value, name) => {
        fields[name] = value;
      });
      if (Object.keys(fields).length > 0) addTrailers(fields);
      controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// ---------------------------------------------------------------------------
// Content-type parity
// ---------------------------------------------------------------------------

/**
 * Reports whether a web `Response` built from this snapshot would carry no
 * `content-type`.
 *
 * The Fetch standard gives only a string body an implied type
 * (`text/plain;charset=UTF-8`); byte and stream bodies get none, and Deno,
 * Bun and Workers send none. `@hono/node-server` instead writes
 * `text/plain; charset=UTF-8` for every body that lacks one, so a streamed or
 * byte response would reach a Node client labelled as text.
 *
 * @param snapshot - The framework response snapshot
 * @returns True when the body is bytes or a stream and no header names a type
 * @internal - Not exported from package index
 */
export function lacksNativeContentType(snapshot: ResponseSnapshot): boolean {
  if (snapshot.body === null || typeof snapshot.body === 'string') {
    return false;
  }
  const init = snapshot.responseInit?.headers;
  if (init === undefined) {
    return !snapshot.headers.has('content-type');
  }
  if (init instanceof Headers) {
    return !init.has('content-type');
  }
  const names = Array.isArray(init) ? init.map(([name]) => name) : Object.keys(init);
  return !names.some((name) => name.toLowerCase() === 'content-type');
}

/**
 * Removes the `content-type` node-server is about to add to one response.
 *
 * Wraps `writeHead` on this exchange only, for one call: node-server writes
 * the head exactly once per response, after it has built the header record
 * with its default type in it.
 *
 * @param outgoing - The Node response for this exchange
 * @internal - Not exported from package index
 */
export function suppressDefaultContentType(outgoing: NodeOutgoing): void {
  const writeHead = outgoing.writeHead;
  outgoing.writeHead = function (status, ...rest) {
    outgoing.writeHead = writeHead;
    for (const arg of rest) {
      if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
        const headers = arg as Record<string, unknown>;
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === 'content-type') {
            delete headers[name];
          }
        }
      }
    }
    return writeHead.call(this, status, ...rest);
  };
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/**
 * The most distinct handshake-failure messages one handle reports. A missing
 * `ws` produces one; the cap stops a hostile peer that varies the failure from
 * growing the set without bound.
 */
const MAX_REPORTED_HANDSHAKE_ERRORS = 16;

/**
 * Internal handle for a Node HTTP server.
 *
 * @internal - Not exported from package index
 */
export class NodeHttpServerHandle {
  #handler: ((request: IRequest) => IResponse | Promise<IResponse>) | null = null;
  #server: NodeServer | null = null;
  readonly #upgrades = new UpgradeRouterStore();
  readonly #coordinator: NodeUpgradeCoordinator;
  readonly #maxBodyBytes: number | undefined;
  readonly #reportError: ((record: Readonly<Record<string, unknown>>) => void) | undefined;
  /**
   * The listener's scheme: `https` only when this adapter terminates TLS. A
   * served request's URL is rewritten to it (V12-51).
   */
  readonly #scheme: 'http' | 'https';
  /**
   * Distinct handshake-failure messages already reported through this handle.
   * One `ws`-absent refusal per upgrade is the same fault; a client must not be
   * able to make the log grow by reconnecting, so a message reports once, and
   * the set is bounded.
   */
  readonly #reportedHandshakeErrors = new Set<string>();

  constructor(wsModule?: WsModuleLike, options?: HttpAdapterOptions) {
    this.#coordinator = new NodeUpgradeCoordinator(wsModule);
    this.#maxBodyBytes = options?.maxBodyBytes;
    this.#reportError = options?.reportError;
    const http2 = options?.http2;
    this.#scheme = http2 !== undefined && http2 !== true ? 'https' : 'http';
  }

  /**
   * Stores the handler set by `setHandler`.
   */
  setHandler(handler: (request: IRequest) => IResponse | Promise<IResponse>): void {
    this.#handler = handler;
  }

  /**
   * Stores the WebSocket upgrade router set by `setUpgradeRouter`.
   */
  setUpgradeRouter(router: WebSocketUpgradeRouter): void {
    this.#upgrades.set(router);
  }

  /**
   * @deprecated gRPC dispatch now runs through the kernel pipeline.
   * This method is retained for backward compatibility but no longer stores
   * or consults an RPC handler.
   */
  setRpcHandler(_handler: RpcFetchHandler): void {
    // No-op — the handler is no longer used (M70a).
  }

  /**
   * Attaches the raw `upgrade` listener to a freshly-created server.
   *
   * A no-op when no upgrade router was installed (so a plain HTTP app never
   * loads `ws`) or when the server handle emits no events. The listener runs
   * the kernel middleware pipeline before performing the handshake (M70a).
   *
   * @param server - The server returned by `serve()`
   */
  attachUpgradeListener(server: NodeServer): void {
    const emitter = this.#upgrades.hasRouter ? asUpgradeEmitter(server) : null;
    if (emitter === null) {
      return;
    }

    emitter.on('upgrade', (...args: never[]): void => {
      const [incoming, socket, head] = args as unknown as [
        NodeIncomingMessage & { readonly socket?: { readonly remoteAddress?: string | undefined } },
        RawUpgradeSocket,
        unknown,
      ];
      // The listener cannot be async — Node ignores a returned promise — so the
      // rejection is handled here rather than escaping as an unhandled one.
      void this.#handleUpgrade(incoming, socket, head).catch(() => {
        rejectRawUpgrade(socket, 500);
      });
    });
  }

  /**
   * M70a pipeline-first: run the kernel middleware pipeline BEFORE performing
   * the WebSocket handshake, so auth, metrics, and security headers apply
   * uniformly. The socket is raw here (not a fetch path), so we create the
   * web Request, map it to IRequest (threading raw), call the framework
   * handler, then check for UPGRADE_INTENT.
   */
  #handleUpgrade(
    incoming: NodeIncomingMessage & {
      readonly socket?: { readonly remoteAddress?: string | undefined };
    },
    socket: RawUpgradeSocket,
    head: unknown,
  ): Promise<void> {
    const request = createUpgradeRequest(incoming);
    const frameworkRequest = mapWebRequestToFrameworkRequest(
      request,
      this.#maxBodyBytes,
      incoming.socket?.remoteAddress,
      { scheme: this.#scheme },
    );
    return this.#handleUpgradePipeline(incoming, frameworkRequest, socket, head);
  }

  async #handleUpgradePipeline(
    incoming: NodeIncomingMessage,
    frameworkRequest: IRequest,
    socket: RawUpgradeSocket,
    head: unknown,
  ): Promise<void> {
    if (!this.#handler) {
      rejectRawUpgrade(socket, 500);
      return;
    }

    const frameworkResponse = await this.#handler(frameworkRequest);

    // Check for UPGRADE_INTENT written by the kernel terminal handler on the
    // IRequest.
    const intent = upgradeIntentOf(frameworkRequest);

    if (intent === undefined) {
      // No upgrade intent — the handler returned a normal response (e.g. 401
      // from auth middleware). Reject the raw upgrade with that status.
      rejectRawUpgrade(socket, frameworkResponse.snapshot().status);
      return;
    }

    // Upgrade intent found — perform the handshake.
    try {
      await this.#coordinator.handshake(incoming, socket, head, intent.sink, intent.protocol);
    } catch (cause) {
      // The kernel already accepted, so release whatever the consumer reserved
      // for this socket before refusing on the wire.
      this.#reportHandshakeFailure(cause);
      intent.sink.onClose({
        code: ABNORMAL_CLOSURE,
        reason: cause instanceof Error ? cause.message : 'Handshake failed',
      });
      rejectRawUpgrade(socket, 500);
    }
  }

  /**
   * Reports a handshake failure at most once per distinct message.
   *
   * Only this catch — a server-side fault (`ws` missing, or `ws` throwing) — is
   * reported. Node's listener catch and the Deno and Workers handshake catches
   * are client-triggerable and stay silent (plan §3.8c). The record is
   * `serializeError` of the cause: the load error's message and stack, no
   * request data.
   *
   * @param cause - The thrown handshake failure
   */
  #reportHandshakeFailure(cause: unknown): void {
    const reportError = this.#reportError;
    if (reportError === undefined) return;
    const serialized = serializeError(cause);
    if (this.#reportedHandshakeErrors.has(serialized.message)) return;
    if (this.#reportedHandshakeErrors.size >= MAX_REPORTED_HANDSHAKE_ERRORS) return;
    this.#reportedHandshakeErrors.add(serialized.message);
    try {
      reportError({ level: 'error', msg: 'WebSocket handshake failed', ...serialized });
    } catch {
      // Reporting must never change the refusal that is already happening.
    }
  }

  /** Shuts down the `ws` server, when one was ever created. */
  closeWebSocketServer(): void {
    this.#coordinator.close();
  }

  /**
   * Gets the underlying Node server (after listen is called).
   */
  get server(): NodeServer | null {
    return this.#server;
  }

  /**
   * Sets the server instance after listen.
   */
  set server(value: NodeServer | null) {
    this.#server = value;
  }

  /**
   * Creates the web-standard fetch handler for @hono/node-server.
   *
   * The framework handler (kernel pipeline) runs FIRST on every request.
   * After it returns, the adapter checks for an upgrade intent written by
   * the kernel terminal handler. WebSocket upgrades on Node arrive via the
   * raw `upgrade` event (not the fetch path), but the upgrade listener also
   * runs the framework handler first before handshaking.
   */
  createFetchHandler(): NodeFetchCallback {
    return (request: Request, env?: NodeFetchEnv): Response | Promise<Response> => {
      // Served requests only: an in-process `fetch` (no `env`) owns its URL
      // and has no connection to carry trailers.
      const frameworkRequest =
        env === undefined
          ? mapWebRequestToFrameworkRequest(request, this.#maxBodyBytes)
          : mapWebRequestToFrameworkRequest(
              request,
              this.#maxBodyBytes,
              peerAddressOf(env.incoming),
              {
                scheme: this.#scheme,
                responseTrailers:
                  env.incoming?.httpVersion === '2.0' &&
                  typeof env.outgoing?.addTrailers === 'function',
              },
            );

      if (!this.#handler) {
        return new Response('Handler not set', { status: 500 });
      }

      // Run the framework handler FIRST — middleware pipeline applies uniformly.
      //
      // Deliberately NOT `await`ed (M87). `@hono/node-server` serves a
      // response through its `responseViaCache` fast path only when this
      // callback returns something that is not a promise, so making the
      // callback `async` foreclosed that path on EVERY request, including the
      // ones the kernel can now answer without ever yielding.
      const frameworkResponse = this.#handler(frameworkRequest);
      if (isPromiseLike(frameworkResponse)) {
        return Promise.resolve(frameworkResponse).then((resolved) =>
          this.#finishFetch(request, frameworkRequest, resolved, env),
        );
      }
      return this.#finishFetch(request, frameworkRequest, frameworkResponse, env);
    };
  }

  /**
   * Completes a fetch-path response once the framework handler has produced
   * one, synchronously where possible.
   *
   * @param request - The original web request
   * @param frameworkRequest - The normalized request, carrying any upgrade intent
   * @param frameworkResponse - The framework response to serialize
   * @param env - node-server's per-request environment, when served by it
   * @returns The web response, or a promise of it when an upgrade is performed
   */
  #finishFetch(
    request: Request,
    frameworkRequest: IRequest,
    frameworkResponse: IResponse,
    env: NodeFetchEnv | undefined,
  ): Response | Promise<Response> {
    // Check for upgrade intent (for the rare case an upgrade reaches fetch).
    const intent = upgradeIntentOf(frameworkRequest);
    if (intent !== undefined) {
      return this.#performUpgrade(request, intent);
    }

    const snapshot = frameworkResponse.snapshot();
    const outgoing = env?.outgoing;
    if (outgoing !== undefined && lacksNativeContentType(snapshot)) {
      suppressDefaultContentType(outgoing);
    }
    // Trailers only where the request said they reach the client — an HTTP/2
    // stream, whose node-server response is the one with `addTrailers`.
    if (
      snapshot.streaming &&
      snapshot.trailers !== undefined &&
      frameworkRequest.responseTrailers === true &&
      outgoing?.addTrailers !== undefined
    ) {
      const addTrailers = outgoing.addTrailers.bind(outgoing);
      return mapSnapshotToWebResponse(
        snapshot,
        streamWithTrailers(snapshot.body, snapshot.trailers, addTrailers),
      );
    }
    return mapSnapshotToWebResponse(snapshot);
  }

  /**
   * Performs the WebSocket handshake using the Node ws module.
   */
  #performUpgrade(_request: Request, intent: WebSocketUpgradeIntent): Response {
    // On Node, upgrades normally arrive through the raw `upgrade` event,
    // not the fetch path. If one does reach here, we cannot perform a
    // real handshake (no native socket available), so refuse honestly.
    intent.sink.onClose({ code: ABNORMAL_CLOSURE, reason: 'Upgrade unsupported on fetch path' });
    return new Response(null, { status: 501 });
  }
}

/**
 * Type guard to check if a handle is a NodeHttpServerHandle.
 *
 * @param handle - The handle to check
 * @returns True if the handle is a NodeHttpServerHandle
 */
export function isNodeHttpServerHandle(handle: ServerHandle): handle is NodeHttpServerHandle {
  return handle instanceof NodeHttpServerHandle;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Node HTTP adapter implementation.
 *
 * @param host - Injected Node serve host (defaults to lazy @hono/node-server)
 * @param wsModule - Injected `ws` module (defaults to a lazy `ws` import)
 * @param options - Adapter options; `maxBodyBytes` bounds the body read and
 * `reportError` receives a server-side handshake failure
 */
export class NodeHttpAdapter implements IHttpAdapter {
  #host: NodeServeHost;
  #handle: NodeHttpServerHandle;
  readonly #http2: true | Http2TlsOptions | undefined;

  constructor(host?: NodeServeHost, wsModule?: WsModuleLike, options?: HttpAdapterOptions) {
    this.#host = host ?? defaultNodeServeHost;
    this.#handle = new NodeHttpServerHandle(wsModule, options);
    this.#http2 = options?.http2;
  }

  setHandler(handler: (request: IRequest) => IResponse | Promise<IResponse>): void {
    this.#handle.setHandler(handler);
  }

  setUpgradeRouter(router: WebSocketUpgradeRouter): void {
    this.#handle.setUpgradeRouter(router);
  }

  setRpcHandler(handler: RpcFetchHandler): void {
    this.#handle.setRpcHandler(handler);
  }

  async listen(port: number, hostname?: string): Promise<ServerHandle> {
    const fetchHandler = this.#handle.createFetchHandler();
    const server = await this.#host.serve({
      fetch: fetchHandler,
      port,
      ...(hostname !== undefined && { hostname }),
      ...(this.#http2 !== undefined && { http2: this.#http2 }),
    });
    this.#handle.server = server;
    // WebSocket upgrades never reach the fetch callback on Node — they arrive
    // on the server's raw `upgrade` event, which only exists once serve() has
    // produced a server.
    this.#handle.attachUpgradeListener(server);
    return this.#handle;
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.#handle.createFetchHandler()(request);
  }

  close(handle: ServerHandle): Promise<void> {
    if (!isNodeHttpServerHandle(handle)) {
      throw new Error('Invalid server handle for NodeHttpAdapter');
    }

    handle.closeWebSocketServer();
    if (handle.server !== null) {
      handle.server.close();
      handle.server = null;
    }
    return Promise.resolve();
  }
}
