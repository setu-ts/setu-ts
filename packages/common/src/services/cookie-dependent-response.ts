/**
 * A request-scoped signal that the response depends on the request's cookies, for a response cache
 * that is not the component that knows it (cache-plugin's `cacheMiddleware`, reading what
 * session-plugin set) and must not import it.
 *
 * @module
 */

/**
 * The `ctx.state` key a component sets to `true` once the response depends on the request's
 * cookies, whatever its `Vary` header ends up saying. `session-plugin` sets it at a request's first
 * application read of the session. A handler can replace the `Vary: Cookie` the plugin appended
 * and set `public` before a cache inside the session middleware captures the response;
 * `cacheMiddleware` reads this key as that lost `Vary: Cookie`: it stores the response only for a
 * request carrying no cookie and no `Authorization`, with `Cookie` added to the stored `Vary`.
 *
 * @example
 * ```typescript
 * const cookieDependent = ctx.state.get(COOKIE_DEPENDENT_RESPONSE_STATE_KEY) === true;
 * ```
 * @since 0.14.0
 */
export const COOKIE_DEPENDENT_RESPONSE_STATE_KEY = 'session-plugin:cookie-dependent-response';
