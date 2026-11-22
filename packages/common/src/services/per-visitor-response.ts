/**
 * A request-scoped signal that the response belongs to one visitor, for a response cache that is
 * not the component that knows it (cache-plugin's `cacheMiddleware`, reading what session-plugin
 * set) and must not import it.
 *
 * @module
 */

/**
 * The `ctx.state` key a component sets to `true` once it knows the response belongs to one visitor
 * whatever its headers end up saying. `session-plugin` sets it at a request's first application
 * write (which also issues or changes the session cookie), at a CSRF token read, and at a read of a restored session holding application data, so a cache inside the session middleware does not store such a
 * response even when the handler then marks it `public`.
 * `cacheMiddleware` never stores a response captured with it set.
 *
 * @example
 * ```typescript
 * const perVisitor = ctx.state.get(PER_VISITOR_RESPONSE_STATE_KEY) === true;
 * ```
 * @since 0.14.0
 */
export const PER_VISITOR_RESPONSE_STATE_KEY = 'session-plugin:per-visitor-response';
