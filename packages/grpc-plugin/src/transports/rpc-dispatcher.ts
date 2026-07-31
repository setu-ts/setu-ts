/**
 * Path-based RPC request dispatcher.
 *
 * Requests whose path starts (after normalizing) with the configured `basePath`
 * are dispatched by exact match to a handler keyed by `basePath + requestPath`.
 * Paths outside the prefix return `null` and fall through to Hono. Paths inside
 * the prefix but with no matching handler return a 404 Response.
 *
 * @module
 */

/**
 * Normalizes a basePath: ensures a single leading slash and no trailing slash.
 * @param path - The base path to normalize
 * @returns The normalized base path
 */
export function normalizeBasePath(path = '/grpc'): string {
  const p = path.trim();
  if (p === '' || p === '/') return '/';
  // Ensure leading slash
  const prefixed = p.startsWith('/') ? p : '/' + p;
  // Remove trailing slash (except the root one)
  return prefixed.endsWith('/') ? prefixed.slice(0, -1) : prefixed;
}

/**
 * Builds a dispatch map from a Connect router's handlers.
 * Each handler carries a `requestPath` property. The map keys are
 * `<basePath>/<requestPath>`.
 *
 * @param basePath - The configured base path (already normalized)
 * @param handlers - Array of Connect router handlers with `requestPath` and `handler`
 * @returns A Map keyed by full path that resolves to the fetch handler
 */
export function buildDispatcherMap(
  basePath: string,
  handlers: Array<{
    requestPath: string;
    handler: (request: Request) => Promise<Response>;
  }>,
): Map<string, (request: Request) => Promise<Response>> {
  const map = new Map<string, (request: Request) => Promise<Response>>();
  for (const { requestPath, handler } of handlers) {
    const key = basePath + requestPath;
    map.set(key, handler);
  }
  return map;
}

/**
 * Dispatches an incoming request. Checks if the request path falls within
 * the basePath prefix, then looks up an exact-match handler. Returns a
 * Response if handled, a 404 for unknown paths within the prefix, or null
 * to fall through.
 *
 * @param request - The native fetch request
 * @param dispatchMap - The map built from Connect router handlers
 * @param basePath - The configured base path (used for prefix check)
 * @returns A Response if the request was handled as RPC, null otherwise
 */
export async function dispatchRequest(
  request: Request,
  dispatchMap: Map<string, (request: Request) => Promise<Response>>,
  basePath: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const requestPath = url.pathname;

  // Fast prefix check (normalized)
  if (!requestPath.startsWith(basePath)) {
    return null;
  }

  // Exact-match lookup
  const handler = dispatchMap.get(requestPath);
  if (handler) {
    return await handler(request);
  }

  // Path exists within prefix but no handler registered → 404
  return new Response('Not Found', { status: 404 });
}