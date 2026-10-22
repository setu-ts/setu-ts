/**
 * Shared form-CSRF exemption: path exclusion and the credential-based bearer
 * rule.
 *
 * A bearer request is exempt ONLY when a header-credential strategy
 * authenticated it AND the request restored no session (the session parked under
 * `SESSION_STATE_KEY`, if any, is new). A request carrying a valid session
 * cookie must present a CSRF token even with a valid bearer token, because the
 * handler would otherwise act on that browser's session (M113e, L3). A
 * non-browser API client sends no session cookie, so its new session keeps the
 * exemption. It fails closed when the session or the credential source is
 * missing.
 *
 * The middleware and {@linkcode verifyCsrfToken} use this one implementation
 * so an action verifying inline cannot disagree with the global policy.
 *
 * @module
 */
import type { IRequestContext, ISession } from '@setu-ts/common';
import { CREDENTIAL_SOURCE_STATE_KEY, SESSION_STATE_KEY } from '@setu-ts/common';

import type { CsrfFormOptions, ResolvedCsrfConfig } from '../options.ts';

/**
 * `Authorization: Bearer <token>`: the scheme matched case-insensitively
 * (RFC 9110 §11.1), then whitespace, then a non-empty token. `Bearer` alone or
 * with only whitespace is not a bearer credential, so it is not exempt.
 */
const BEARER = /^bearer[ \t]+\S/i;

/** Whether an explicit path exclusion matches this request. */
export function isCsrfExcluded(ctx: IRequestContext, exclude: CsrfFormOptions['exclude']): boolean {
  for (const entry of exclude ?? []) {
    if (typeof entry === 'string') {
      if (entry === ctx.request.path) return true;
      continue;
    }
    entry.lastIndex = 0;
    if (entry.test(ctx.request.path)) return true;
  }
  return false;
}

/**
 * Whether the request carries a bearer credential (M113e, V9-27).
 *
 * @param headers - The request headers
 * @returns `true` for `Authorization: Bearer <token>`
 */
export function isBearerRequest(headers: Headers): boolean {
  const value = headers.get('authorization');
  return value !== null && BEARER.test(value);
}

/**
 * The `ctx.state` key under which form CSRF marks a request the BEARER exemption
 * admitted, so `sessionMiddleware` does not commit its session (M113e, L4).
 *
 * Internal to `session-plugin` — both writer and reader live here — so it is
 * not in `common` and not on the barrel.
 */
export const BEARER_EXEMPT_STATE_KEY = 'session-plugin:bearer-exempt';

/**
 * Whether the bearer rule exempts this request: `exemptBearer` is on, the
 * request carries `Authorization: Bearer <token>`, a `'header'`-credential
 * strategy authenticated it (recorded under `CREDENTIAL_SOURCE_STATE_KEY` by the
 * authentication middleware), AND it restored no session — the session
 * `session-plugin` parked under `SESSION_STATE_KEY` is new (`isNew === true`).
 *
 * A request carrying a valid session cookie must present a CSRF token even with
 * a valid bearer token, because the handler would otherwise act on that
 * browser's session (M113e, L3). An unauthenticated bearer header, a request the
 * session cookie (a `'cookie'` credential) authenticated, or a request whose
 * session was restored is still verified. A non-browser API client sends no
 * session cookie, so its new session keeps the exemption. This fails closed
 * when the session or the credential source is missing.
 *
 * @param ctx - The request context
 * @param config - The resolved CSRF configuration
 * @returns `true` when the bearer rule exempts the request
 */
export function isBearerExempt(ctx: IRequestContext, config: ResolvedCsrfConfig): boolean {
  const session = ctx.state.get(SESSION_STATE_KEY) as ISession | undefined;
  return (
    config.exemptBearer &&
    isBearerRequest(ctx.request.headers) &&
    ctx.state.get(CREDENTIAL_SOURCE_STATE_KEY) === 'header' &&
    session?.isNew === true
  );
}

/**
 * Whether form-CSRF verification is skipped for this request: the bearer rule
 * ({@linkcode isBearerExempt}) or an explicit path exclusion. Pure — it records
 * nothing; the entry points call {@linkcode applyCsrfExemption}.
 *
 * @param ctx - The request context
 * @param config - The resolved CSRF configuration
 * @param exclude - The configured path exclusions
 * @returns `true` when verification must not run
 */
export function isCsrfExempt(
  ctx: IRequestContext,
  config: ResolvedCsrfConfig,
  exclude: CsrfFormOptions['exclude'],
): boolean {
  return isBearerExempt(ctx, config) || isCsrfExcluded(ctx, exclude);
}

/**
 * {@linkcode isCsrfExempt}, and when the BEARER rule is what exempts the request,
 * marks it under {@linkcode BEARER_EXEMPT_STATE_KEY} so its session is not
 * committed (M113e, L4).
 *
 * The bearer rule admits only a request that restored no session, but the
 * handler could still WRITE one, and the commit would send it as `Set-Cookie`.
 * On a credentialed CORS response that plants an attacker-written session in a
 * browser whose cookie was dead. A header-authenticated request has no business
 * writing a browser session, so it gets none. Both entry points — the
 * middleware and {@linkcode verifyCsrfToken} — call this, so they agree.
 *
 * @param ctx - The request context
 * @param config - The resolved CSRF configuration
 * @param exclude - The configured path exclusions
 * @returns `true` when verification must not run
 */
export function applyCsrfExemption(
  ctx: IRequestContext,
  config: ResolvedCsrfConfig,
  exclude: CsrfFormOptions['exclude'],
): boolean {
  if (isBearerExempt(ctx, config)) {
    ctx.state.set(BEARER_EXEMPT_STATE_KEY, true);
    return true;
  }
  return isCsrfExcluded(ctx, exclude);
}
