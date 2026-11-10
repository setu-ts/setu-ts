/**
 * Path-based RPC dispatch.
 *
 * Detection is **prefix-only**, deliberately: Connect's real unary content
 * types include `application/json` and `application/proto`, so media-type
 * sniffing would classify every ordinary JSON POST as RPC and hijack the
 * application's own routes (M70a plan §3.4,
 * `plans/archive/milestone-70a-pipeline-bypass.md`). A Connect/gRPC client is
 * configured with a base URL, so the prefix is sufficient and unambiguous.
 *
 * Within the prefix, dispatch is an exact-match `Map` lookup keyed by
 * `basePath + handler.requestPath`, built once at router-build time.
 *
 * @module
 */

import type { RpcReply, RpcTransport } from '@setu-ts/common';

import { isNativeGrpcContentType, trailersOnlyUnimplemented } from './grpc-binary-refusal.ts';

/**
 * One procedure in the dispatch map (M139b): its Connect fetch handler, its
 * native-gRPC path, and which sides of the call stream.
 */
export interface DispatchEntry {
  /**
   * Connect, gRPC-Web — and anything else `createFetchHandler` serves. A
   * `signal` replaces the request's own as the call's cancellation signal.
   */
  readonly fetch: (request: Request, signal?: AbortSignal) => Promise<Response>;
  /** Native `application/grpc` with trailers, for a connection that carries them. */
  readonly native: (request: Request, signal?: AbortSignal) => Promise<RpcReply>;
  /** `true` for a client-streaming or bidirectional procedure. */
  readonly streamsRequest: boolean;
  /** `true` for a server-streaming or bidirectional procedure. */
  readonly streamsResponse: boolean;
}

/** The dispatch map: entries keyed by `basePath + requestPath`. */
export type DispatchMap = ReadonlyMap<string, DispatchEntry>;

/**
 * Which sides of a call stream, from its descriptor's `methodKind`. A handler
 * with no kind (hand-built) is unary.
 *
 * @param methodKind - `DescMethod.methodKind`
 * @returns Whether the request and the response stream
 */
export function streamingSides(methodKind: string | undefined): {
  readonly streamsRequest: boolean;
  readonly streamsResponse: boolean;
} {
  return {
    streamsRequest: methodKind === 'client_streaming' || methodKind === 'bidi_streaming',
    streamsResponse: methodKind === 'server_streaming' || methodKind === 'bidi_streaming',
  };
}

/**
 * The default base path: the **root**. A gRPC client derives its request path
 * from the fully-qualified method name alone — no client (grpcurl, grpcui,
 * grpc-go, grpc-java) has a prefix option, so a non-root default makes the
 * server unreachable by every native tool the feature list names.
 *
 * This is the single home for the default: `normalizeBasePath`'s default
 * parameter and `GrpcService` both read it, so the value cannot drift into
 * two spellings. `DEFAULT_BASE_PATH` is internal — it is NOT barrel-exported.
 *
 * Normalizing it yields `''` (see {@linkcode normalizeBasePath}), which is
 * what "mounted at the root" means to the dispatch map.
 */
export const DEFAULT_BASE_PATH = '/';

/**
 * Normalizes a `basePath` to a form safe to concatenate: a single leading
 * slash and no trailing slash.
 *
 * A root base path (`''`, `'/'`) normalizes to the **empty string**, not `'/'`.
 * Returning `'/'` would make `basePath + requestPath` produce a double-slashed
 * key (`//pkg.Svc/Method`) that no request can ever match.
 *
 * @param path - The configured base path. Defaults to {@linkcode DEFAULT_BASE_PATH}.
 * @returns The normalized prefix; `''` means "mounted at the root".
 */
export function normalizeBasePath(path: string = DEFAULT_BASE_PATH): string {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/') {
    return '';
  }
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return prefixed.endsWith('/') ? prefixed.slice(0, -1) : prefixed;
}

/**
 * Whether a request path lies inside the base path.
 *
 * The check is segment-aware: with `basePath` `/grpc`, the path `/grpcfoo`
 * is NOT inside it. A bare `startsWith` would claim that path, 404 it, and
 * shadow an ordinary Hono route whose name merely begins with the prefix.
 *
 * @param requestPath - The request's `URL.pathname`.
 * @param basePath - An already-normalized base path.
 */
export function isWithinBasePath(requestPath: string, basePath: string): boolean {
  if (basePath === '') {
    return true;
  }
  return requestPath === basePath || requestPath.startsWith(`${basePath}/`);
}

/**
 * Dispatches a request against the RPC handler map.
 *
 * @param request - The native fetch request.
 * @param dispatchMap - Entries keyed by `basePath + requestPath`.
 * @param basePath - An already-normalized base path.
 * @param transport - What the connection can carry, and the client's signal (M139b). Absent means no
 *   trailers.
 * @returns The RPC reply; a Trailers-Only `UNIMPLEMENTED` refusal for a matched
 *   native `application/grpc` request on a connection without trailers; a
 *   `404` for an unknown procedure inside a non-root `basePath`; or `null` to
 *   fall through to Hono.
 *
 * A miss under a ROOT base path falls through rather than answering `404` —
 * at the root, "not a known procedure" is indistinguishable from "an ordinary
 * application route", and 404-ing would take the whole application down.
 *
 * A MATCHED native request is served through the universal handler, with its
 * status in real trailers, when `transport.trailers` is `true` — an HTTP/2
 * connection to an adapter that writes them. Anywhere else it is refused with
 * a Trailers-Only `UNIMPLEMENTED` BEFORE the handler is invoked: a reply whose
 * status cannot reach the client is one no conformant client can interpret.
 * Connect and gRPC-Web pass through untouched; their status travels in the
 * body.
 */
export function dispatchRequest(
  request: Request,
  dispatchMap: DispatchMap,
  basePath: string,
  transport?: RpcTransport,
): Promise<RpcReply | null> | null {
  const requestPath = new URL(request.url).pathname;

  if (!isWithinBasePath(requestPath, basePath)) {
    return null;
  }

  const entry = dispatchMap.get(requestPath);
  if (entry !== undefined) {
    if (isNativeGrpcContentType(request.headers.get('content-type'))) {
      return transport?.trailers === true
        ? entry.native(request, transport.signal)
        : Promise.resolve({ response: trailersOnlyUnimplemented(), streaming: false });
    }
    return entry
      .fetch(request, transport?.signal)
      .then((response) => ({ response, streaming: entry.streamsResponse }));
  }

  if (basePath === '') {
    return null;
  }

  return Promise.resolve({
    response: new Response('Not Found', { status: 404 }),
    streaming: false,
  });
}
