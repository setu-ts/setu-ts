/**
 * Request-scoped access to the form-CSRF token, for a component that is not the session plugin
 * (openapi-plugin's Swagger UI token route) and must not import it.
 *
 * @module
 */

/**
 * The `ctx.state` key under which `session-plugin`'s form-CSRF middleware publishes an
 * {@linkcode ICsrfTokenAccess} for the request, and from which `openapi-plugin`'s Swagger UI token
 * route reads it. Absent when form CSRF is not installed.
 *
 * @example
 * ```typescript
 * const access = ctx.state.get(CSRF_TOKEN_ACCESS_STATE_KEY) as ICsrfTokenAccess | undefined;
 * ```
 * @since 0.14.0
 */
export const CSRF_TOKEN_ACCESS_STATE_KEY = 'session-plugin:csrf-token-access';

/**
 * The form-CSRF token of the request's session, published per request by `session-plugin`'s
 * form-CSRF middleware under {@linkcode CSRF_TOKEN_ACCESS_STATE_KEY}. The object is frozen.
 *
 * @since 0.14.0
 */
export interface ICsrfTokenAccess {
  /** The request header the verifier reads the token from (default `x-csrf-token`). */
  readonly headerName: string;
  /**
   * The token of a session this request restored, minted when it has none yet. `undefined` for a
   * request that restored no session, so a call never starts one.
   */
  tokenForExistingSession(): string | undefined;
}
