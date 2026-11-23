/**
 * The Swagger UI `requestInterceptor` that sends the form-CSRF token on Try-it-out calls.
 *
 * Embedded into the Swagger UI page through `Function.prototype.toString()`, so the factory must be
 * self-contained: no imports, and nothing it reads from outside its own parameters. Not exported
 * from the package barrel.
 *
 * @module
 */

/** The request object Swagger UI hands its interceptor (the fields this one reads or writes). */
export interface SwaggerRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

/** What the interceptor reads from the browser: the page's location and `fetch`. */
export interface InterceptorScope {
  readonly location: { readonly href: string; readonly origin: string };
  readonly fetch: (
    url: string,
    init: { credentials: 'same-origin' },
  ) => Promise<{ readonly status: number; json(): Promise<unknown> }>;
}

/**
 * Builds the interceptor. It acts only on a same-origin request whose method, uppercased, is not
 * `GET`, `HEAD` or `OPTIONS` (Swagger UI sends Try-it-out methods in lowercase): it fetches the
 * token from `tokenUrl` and, on a `200`, sets the named header. Every other request (the spec load,
 * `$ref` resolution, an OAuth2 token request to an outside provider, a call to a server on another
 * origin) passes unchanged with no fetch, and so does any request when the token route answers
 * `204` or the fetch fails. Concurrent calls share one token fetch, so a session that has no token
 * yet mints exactly one and every call sends it; the next call after it settles fetches again.
 *
 * @param tokenUrl - The plugin's own token route
 * @param scope - The browser globals (`window` in the page)
 * @returns The interceptor Swagger UI calls with each request
 */
export function createCsrfRequestInterceptor(
  tokenUrl: string,
  scope: InterceptorScope,
): (request: SwaggerRequest) => Promise<SwaggerRequest> {
  let pending:
    Promise<{ readonly headerName: string; readonly token: string } | undefined> | undefined;
  const fetchToken = async (): Promise<
    { readonly headerName: string; readonly token: string } | undefined
  > => {
    try {
      const response = await scope.fetch(tokenUrl, { credentials: 'same-origin' });
      if (response.status !== 200) {
        return undefined;
      }
      const body = (await response.json()) as { headerName?: unknown; token?: unknown };
      return typeof body.headerName === 'string' && typeof body.token === 'string'
        ? { headerName: body.headerName, token: body.token }
        : undefined;
    } catch {
      // A failed token fetch leaves the request as Swagger UI built it.
      return undefined;
    }
  };
  return async (request) => {
    try {
      const origin = new URL(request.url, scope.location.href).origin;
      const method = (request.method ?? 'GET').toUpperCase();
      if (
        origin !== scope.location.origin ||
        method === 'GET' ||
        method === 'HEAD' ||
        method === 'OPTIONS'
      ) {
        return request;
      }
      if (pending === undefined) {
        const shared = fetchToken();
        pending = shared;
        void shared.then(() => {
          if (pending === shared) pending = undefined;
        });
      }
      const found = await pending;
      if (found !== undefined) {
        request.headers = { ...request.headers, [found.headerName]: found.token };
      }
    } catch {
      // A request URL that cannot be parsed passes unchanged.
    }
    return request;
  };
}
