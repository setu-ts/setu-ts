/**
 * Path-based RPC dispatch.
 *
 * Detection is **prefix-only**, deliberately: Connect's real unary content
 * types include `application/json` and `application/proto`, so media-type
 * sniffing would classify every ordinary JSON POST as RPC and hijack the
 * application's own routes (plan §3.4). A Connect/gRPC client is configured
 * with a base URL, so the prefix is sufficient and unambiguous.
 *
 * Within the prefix, dispatch is an exact-match `Map` lookup keyed by
 * `basePath + handler.requestPath`, built once at router-build time.
 *
 * @module
 */

import { isNativeGrpcContentType, trailersOnlyUnimplemented } from './grpc-binary-refusal.ts';

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
export function normalizeBasePath(path = DEFAULT_BASE_PATH): string {
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
 * @param dispatchMap - Handlers keyed by `basePath + requestPath`.
 * @param basePath - An already-normalized base path.
 * @returns The RPC {@linkcode Response}; a Trailers-Only `UNIMPLEMENTED`
 *   refusal for a matched native `application/grpc` request; a `404` for an
 *   unknown procedure inside a non-root `basePath`; or `null` to fall through
 *   to Hono.
 *
 * A miss under a ROOT base path falls through rather than answering `404` —
 * at the root, "not a known procedure" is indistinguishable from "an ordinary
 * application route", and 404-ing would take the whole application down.
 *
 * A MATCHED request whose content type is native gRPC (`application/grpc`,
 * `+proto`, `+json`) is refused with a Trailers-Only `UNIMPLEMENTED` response
 * BEFORE the handler is invoked (§3.3): the fetch `Response` cannot carry the
 * HTTP/2 trailers the native format signals completion with, so the handler's
 * reply would be a response no conformant client can interpret. Connect and
 * gRPC-Web pass through untouched.
 */
export function dispatchRequest(
  request: Request,
  dispatchMap: ReadonlyMap<string, (request: Request) => Promise<Response>>,
  basePath: string,
): Promise<Response | null> | null {
  const requestPath = new URL(request.url).pathname;

  if (!isWithinBasePath(requestPath, basePath)) {
    return null;
  }

  const handler = dispatchMap.get(requestPath);
  if (handler !== undefined) {
    if (isNativeGrpcContentType(request.headers.get('content-type'))) {
      return Promise.resolve(trailersOnlyUnimplemented());
    }
    return handler(request);
  }

  if (basePath === '') {
    return null;
  }

  return Promise.resolve(new Response('Not Found', { status: 404 }));
}
