/**
 * Shared form-CSRF exemption: path exclusion and the bearer rule.
 *
 * The middleware and {@linkcode verifyCsrfToken} use this one implementation
 * so an action verifying inline cannot disagree with the global policy.
 *
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';

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
 * Whether form-CSRF verification is skipped for this request: an explicit path
 * exclusion, or a bearer request while `exemptBearer` is on.
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
  return (
    (config.exemptBearer && isBearerRequest(ctx.request.headers)) || isCsrfExcluded(ctx, exclude)
  );
}
