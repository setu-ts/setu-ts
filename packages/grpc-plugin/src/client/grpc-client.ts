/**
 * The calling side of the plugin (M139b §3.12). Internal — reached through
 * `GrpcService.client` and the exported `grpcClient()`.
 *
 * A client is Connect's own `createClient` over a delegating transport. Each
 * call picks the target's origin — fixed for a URL target, through service
 * discovery for a name — runs on a transport cached for that origin (one HTTP/2
 * session per origin), and reports its outcome back to discovery.
 *
 * @module
 */
import { contextToTraceparent } from '@setu-ts/common';
import type {
  GrpcClientOptions,
  GrpcServiceDefinition,
  IServiceDiscovery,
  ITelemetryService,
  RuntimePlatform,
  ServiceInstance,
} from '@setu-ts/common';

import type { ClientTransportLike, ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { ConnectNodeModuleLike, Http2SessionLike } from './connect-node-loader.ts';

/** Every option, resolved. */
type ResolvedClientOptions = Required<GrpcClientOptions>;

/** The defaults §3.12 settles on. */
export const CLIENT_DEFAULTS: ResolvedClientOptions = {
  basePath: '',
  protocol: 'connect',
  httpVersion: '2',
  timeoutMs: 5000,
};

/** How many origins keep a transport (and session) before the oldest is closed. */
export const MAX_CLIENT_ORIGINS = 64;

const PROTOCOLS: ReadonlySet<string> = new Set(['connect', 'grpc', 'grpc-web']);
const HTTP_VERSIONS: ReadonlySet<string> = new Set(['2', '1.1']);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Checks client options, so a misconfiguration fails where it is written.
 *
 * @param options - The options
 * @param where - Who passed them, for the message
 * @throws {TypeError} Naming the first option out of range
 */
export function validateClientOptions(options: GrpcClientOptions, where: string): void {
  const { basePath, protocol, httpVersion, timeoutMs } = options;
  if (
    basePath !== undefined &&
    (typeof basePath !== 'string' ||
      (basePath !== '' && (!basePath.startsWith('/') || basePath.endsWith('/'))))
  ) {
    throw new TypeError(
      `${where}: basePath must be '' or start with '/' and not end with one, received ${JSON.stringify(basePath)}`,
    );
  }
  if (protocol !== undefined && !PROTOCOLS.has(protocol)) {
    throw new TypeError(
      `${where}: protocol must be 'connect', 'grpc' or 'grpc-web', received ${JSON.stringify(protocol)}`,
    );
  }
  if (httpVersion !== undefined && !HTTP_VERSIONS.has(httpVersion)) {
    throw new TypeError(
      `${where}: httpVersion must be '2' or '1.1', received ${JSON.stringify(httpVersion)}`,
    );
  }
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
  ) {
    throw new TypeError(
      `${where}: timeoutMs must be an integer from 1 to 2147483647, received ${String(timeoutMs)}`,
    );
  }
  if (protocol === 'grpc' && httpVersion === '1.1') {
    throw new TypeError(`${where}: protocol 'grpc' needs httpVersion '2'`);
  }
}

/**
 * A URL target's base, or `undefined` for a service name.
 *
 * @param target - The target
 * @returns The origin plus any path, without a trailing slash
 * @throws {TypeError} For an empty target or a URL that is not `http(s)`
 */
export function targetBase(target: string): string | undefined {
  if (typeof target !== 'string' || target === '') {
    throw new TypeError('grpc client: target must be a URL or a service name');
  }
  if (!SCHEME.test(target)) return undefined;
  const url = new URL(target);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`grpc client: target URL must be http or https, received ${url.protocol}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * An instance's origin, as the discovery plugin formats it (IPv6 bracketed).
 *
 * @param instance - The instance
 * @returns `scheme://host:port`
 */
export function instanceOrigin(instance: ServiceInstance): string {
  const scheme = instance.secure === true ? 'https' : 'http';
  const host = instance.host.includes(':') ? `[${instance.host}]` : instance.host;
  return `${scheme}://${host}:${instance.port}`;
}

/** connect-node's message for a `REFUSED_STREAM` reset code (`connectErrorFromH2ResetCode`). */
const CONNECT_NODE_REFUSED = 'http/2 stream closed with error code REFUSED_STREAM (0x7)';

/**
 * Whether a call failed because the server refused its HTTP/2 stream
 * (`REFUSED_STREAM`, RFC 9113 §8.7): the server did not process it, which a
 * server that has sent `GOAWAY` while shutting down does to a stream already on
 * the wire. connect-node maps the reset code to `Unavailable` when it reads it,
 * but reports the stream-error event Node raises for the same refusal as
 * `Internal`; the cause chain names it either way. A stream that could not be
 * opened because the session had already received `GOAWAY`
 * (`ERR_HTTP2_GOAWAY_SESSION`) is the same case: the request never left.
 *
 * @param error - The call's error
 * @returns `true` when some error in the cause chain is that refusal
 */
export function isRefusedStream(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { message, code, cause } = current as {
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (typeof message === 'string') {
      // Node's stream error for the refusal, and connect-node's reading of the
      // reset code: exactly these two, so a server's own error message that
      // happens to name the code is never taken for a refusal and retried.
      if (code === 'ERR_HTTP2_STREAM_ERROR' && message.includes('NGHTTP2_REFUSED_STREAM')) {
        return true;
      }
      // The stream was never opened: the session had already received GOAWAY
      // (seen on Bun, whose node:http2 races the session manager's reconnect).
      if (code === 'ERR_HTTP2_GOAWAY_SESSION') return true;
      if (message.includes(CONNECT_NODE_REFUSED)) return true;
    }
    current = cause;
  }
  return false;
}

/** A refused stream, carrying the `Unavailable` error the caller will see. */
class RefusedStream {
  // A field, not a parameter property: the sources run through type stripping,
  // which accepts only erasable syntax.
  readonly error: Error;
  constructor(error: Error) {
    this.error = error;
  }
}

/** What a client needs from the plugin. */
export interface GrpcClientDeps {
  /** The Connect runtime: `createClient` and its errors. */
  readonly runtime: ConnectRuntime;
  /** Loads `@connectrpc/connect-node` on the first call. */
  readonly loadNode: () => Promise<ConnectNodeModuleLike>;
  /** Service discovery, resolved when used, or `undefined` when none is registered. */
  readonly discovery: () => IServiceDiscovery | undefined;
  /** Telemetry, resolved when used, or `undefined` when none is registered. */
  readonly telemetry: () => ITelemetryService | undefined;
  /** Per-target defaults from `GrpcPluginOptions.clients`. */
  readonly targets: Readonly<Record<string, GrpcClientOptions>>;
  /** The runtime platform, when a runtime capability reports one. */
  readonly platform?: () => RuntimePlatform | undefined;
}

/**
 * Why a client is refused on Cloudflare Workers, measured on `workerd`
 * (2026-11-11): connect-node loads, but an HTTP/2 call rejects `Internal`
 * ("The http2.connect method is not implemented") and an HTTP/1.1 call hangs
 * until its deadline. Refused where it is asked for, with the alternatives.
 */
export const WORKERS_REFUSAL =
  "grpc client: not available on Cloudflare Workers — its transport, @connectrpc/connect-node, needs node:http2, which workerd does not implement; call the service with Connect's @connectrpc/connect-web transport, or through a service binding";

/** One cached transport and the session under it. */
interface OriginEntry {
  readonly transport: ClientTransportLike;
  readonly session: Http2SessionLike | undefined;
}

/** Every client of one plugin instance, their transports and their sessions. */
export class GrpcClients {
  readonly #deps: GrpcClientDeps;
  readonly #clients = new WeakMap<object, Map<string, unknown>>();
  readonly #origins = new Map<string, OriginEntry>();
  /** The connect-node import while it loads; then {@linkcode GrpcClients.#node}. */
  #loading: Promise<ConnectNodeModuleLike> | undefined;
  /** connect-node once loaded, so a call no longer waits on the import's promise. */
  #node: ConnectNodeModuleLike | undefined;
  #closed = false;

  constructor(deps: GrpcClientDeps) {
    this.#deps = deps;
  }

  /** How many origins hold a transport; for tests and the bound. */
  get originCount(): number {
    return this.#origins.size;
  }

  /**
   * The client for a service at a target, cached per options.
   *
   * @param definition - The service descriptor
   * @param target - A URL or a service name
   * @param options - Per-client overrides
   * @returns The Connect client
   */
  client(
    definition: GrpcServiceDefinition,
    target: string,
    options: GrpcClientOptions = {},
  ): unknown {
    if (this.#deps.platform?.() === 'cloudflare-workers') throw new TypeError(WORKERS_REFUSAL);
    validateClientOptions(options, 'grpc client');
    const base = targetBase(target);
    if (base === undefined && this.#deps.discovery() === undefined) {
      throw new TypeError(
        `grpc client: "${target}" is a service name, but no service discovery is registered; register ServiceDiscoveryPlugin or pass a URL`,
      );
    }
    const resolved: ResolvedClientOptions = {
      ...CLIENT_DEFAULTS,
      ...this.#deps.targets[target],
      ...options,
    };
    validateClientOptions(resolved, 'grpc client');
    const key = `${target}\u0000${resolved.basePath}\u0000${resolved.protocol}\u0000${resolved.httpVersion}\u0000${resolved.timeoutMs}`;
    let byKey = this.#clients.get(definition);
    if (byKey === undefined) {
      byKey = new Map();
      this.#clients.set(definition, byKey);
    }
    const cached = byKey.get(key);
    if (cached !== undefined) return cached;
    const created = this.#deps.runtime.createClient(
      definition,
      this.#delegate(target, base, resolved),
    );
    byKey.set(key, created);
    return created;
  }

  /** Closes every session; later calls reject as `Unavailable`. */
  close(): void {
    this.#closed = true;
    for (const entry of this.#origins.values()) entry.session?.abort();
    this.#origins.clear();
  }

  #delegate(
    target: string,
    base: string | undefined,
    options: ResolvedClientOptions,
  ): ClientTransportLike {
    return {
      // A unary call can be sent again: its input is one message. A streaming
      // call's input may already be consumed, so it is never retried.
      // The trace header is set on the call's own headers, not through a Connect
      // interceptor: an interceptor is one more async layer on every call, even
      // one with no active span to carry.
      unary: (method, signal, timeoutMs, header, input, contextValues) => {
        const traced = this.#withTraceparent(header);
        return this.#call(target, base, options, true, (transport) =>
          transport.unary(method, signal, timeoutMs, traced, input, contextValues),
        );
      },
      stream: (method, signal, timeoutMs, header, input, contextValues) => {
        const traced = this.#withTraceparent(header);
        return this.#call(target, base, options, false, (transport) =>
          transport.stream(method, signal, timeoutMs, traced, input, contextValues),
        );
      },
    };
  }

  /**
   * Runs one call, retrying a unary call once when the server refused its
   * stream (see {@linkcode isRefusedStream}).
   */
  async #call(
    target: string,
    base: string | undefined,
    options: ResolvedClientOptions,
    retryable: boolean,
    run: (transport: ClientTransportLike) => Promise<unknown>,
  ): Promise<unknown> {
    try {
      return await this.#attempt(target, base, options, run);
    } catch (error) {
      if (retryable && error instanceof RefusedStream) {
        return this.#attempt(target, base, options, run).catch((again: unknown) => {
          throw again instanceof RefusedStream ? again.error : again;
        });
      }
      throw error instanceof RefusedStream ? error.error : error;
    }
  }

  async #attempt(
    target: string,
    base: string | undefined,
    options: ResolvedClientOptions,
    run: (transport: ClientTransportLike) => Promise<unknown>,
  ): Promise<unknown> {
    const { runtime } = this.#deps;
    if (this.#closed) throw runtime.unavailable('the gRPC client is closed');
    let origin = base;
    let instance: ServiceInstance | undefined;
    let discovery: IServiceDiscovery | undefined;
    if (origin === undefined) {
      discovery = this.#deps.discovery();
      if (discovery === undefined) {
        throw runtime.unavailable(`no service discovery to resolve "${target}"`);
      }
      instance = (await discovery.pick(target)) ?? undefined;
      if (instance === undefined) {
        throw runtime.unavailable(`no instance of "${target}" is available`);
      }
      origin = instanceOrigin(instance);
    }
    const pending = this.#transport(`${origin}${options.basePath}`, options);
    const transport = pending instanceof Promise ? await pending : pending;
    try {
      const result = await run(transport);
      this.#report(discovery, instance, 'success');
      return result;
    } catch (error) {
      if (isRefusedStream(error)) {
        // The server never processed it: the instance's fault, and safe to send again.
        this.#report(discovery, instance, 'failure');
        throw new RefusedStream(
          runtime.isUnavailable(error)
            ? (error as Error)
            : runtime.unavailable(`"${target}" refused the call before processing it`, error),
        );
      }
      this.#report(discovery, instance, runtime.isUnavailable(error) ? 'failure' : 'success');
      throw error;
    }
  }

  /** Reports an outcome; a failing report never changes the call's. */
  #report(
    discovery: IServiceDiscovery | undefined,
    instance: ServiceInstance | undefined,
    outcome: 'success' | 'failure',
  ): void {
    if (discovery === undefined || instance === undefined) return;
    try {
      discovery.report(instance, outcome);
    } catch {
      // Discovery's bookkeeping is advisory; the call already has its answer.
    }
  }

  /** The transport for an origin: synchronous once connect-node has loaded. */
  #transport(
    url: string,
    options: ResolvedClientOptions,
  ): ClientTransportLike | Promise<ClientTransportLike> {
    if (this.#node !== undefined) return this.#transportFrom(this.#node, url, options);
    return (this.#loading ??= this.#deps.loadNode()).then((node) => {
      this.#node = node;
      return this.#transportFrom(node, url, options);
    });
  }

  #transportFrom(
    node: ConnectNodeModuleLike,
    url: string,
    options: ResolvedClientOptions,
  ): ClientTransportLike {
    // Closed while discovery picked: open no session the close cannot reach.
    if (this.#closed) throw this.#deps.runtime.unavailable('the gRPC client is closed');
    const key = `${options.protocol}|${options.httpVersion}|${options.timeoutMs}|${url}`;
    const hit = this.#origins.get(key);
    if (hit !== undefined) {
      // Least recently used last out: move a hit to the end.
      this.#origins.delete(key);
      this.#origins.set(key, hit);
      return hit.transport;
    }
    const session = options.httpVersion === '2' ? new node.Http2SessionManager(url) : undefined;
    const transportOptions: Record<string, unknown> = {
      baseUrl: url,
      httpVersion: options.httpVersion,
      useBinaryFormat: true,
      defaultTimeoutMs: options.timeoutMs,
      ...(session === undefined ? {} : { sessionManager: session }),
    };
    const transport =
      options.protocol === 'grpc'
        ? node.createGrpcTransport(transportOptions)
        : options.protocol === 'grpc-web'
          ? node.createGrpcWebTransport(transportOptions)
          : node.createConnectTransport(transportOptions);
    this.#origins.set(key, { transport, session });
    if (this.#origins.size > MAX_CLIENT_ORIGINS) {
      const [oldestKey, oldest] = this.#origins.entries().next().value as [string, OriginEntry];
      this.#origins.delete(oldestKey);
      oldest.session?.abort();
    }
    return transport;
  }

  /**
   * The call's headers with the active span's `traceparent` added, unless it
   * already carries one. Unchanged — no copy — when there is no span.
   */
  #withTraceparent(header: HeadersInit | undefined): HeadersInit | undefined {
    const value = this.#traceparent();
    if (value === null) return header;
    const headers = new Headers(header);
    if (!headers.has('traceparent')) headers.set('traceparent', value);
    return headers;
  }

  /** The active span as a `traceparent`, or `null` when there is none. */
  #traceparent(): string | null {
    try {
      const context = this.#deps.telemetry()?.activeSpanContext?.();
      return context === undefined ? null : contextToTraceparent(context);
    } catch {
      // Telemetry must not fail a call it only annotates.
      return null;
    }
  }
}
