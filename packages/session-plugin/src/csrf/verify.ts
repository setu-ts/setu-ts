/**
 * CSRF verification, shared by the middleware and by handlers that check the
 * token themselves.
 *
 * Both entry points call {@linkcode verifyCsrfToken}, so a React Router action
 * that validates inline cannot drift from what the middleware enforces.
 *
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';

import { timingSafeEqualStrings } from '../codec/timing-safe.ts';
import { CsrfTokenMismatchError } from '../errors.ts';
import type { CsrfFormOptions, ResolvedCsrfConfig } from '../options.ts';
import { resolveCsrfConfig } from '../options.ts';
import { getSession } from '../services/get-session.ts';
import { readCsrfToken } from './token.ts';

/** Content type carrying a plain HTML form post. */
const FORM_URLENCODED = 'application/x-www-form-urlencoded';

/**
 * Verifies the request's CSRF token against the session's, throwing on any
 * mismatch.
 *
 * Exported so a handler or framework action can validate inline — React Router
 * actions conventionally do their own validation rather than relying on
 * middleware. The middleware calls exactly this function, so the two can never
 * disagree.
 *
 * Reading the body here is safe: the runtime's request mapping pre-reads it into
 * a buffer, so `text()` is replayable and the handler can still read the body
 * afterwards.
 *
 * @param ctx - The request context
 * @param options - CSRF options; defaults match the plugin's
 * @throws {CsrfTokenMismatchError} If the token is absent, malformed, or wrong
 * @throws {SessionMiddlewareMissingError} If the session middleware did not run
 * @example
 * ```typescript
 * export async function action({ context }: ActionFunctionArgs) {
 *   await verifyCsrfToken(context.get(ctxKey));
 *   // … safe to mutate
 * }
 * ```
 * @since 0.2.0
 */
export async function verifyCsrfToken(
  ctx: IRequestContext,
  options: CsrfFormOptions = {},
): Promise<void> {
  await verifyWithConfig(ctx, resolveCsrfConfig(options));
}

/**
 * Verification against an already-resolved config, so the middleware resolves
 * its options once at registration rather than on every request.
 *
 * @param ctx - The request context
 * @param config - Pre-resolved CSRF configuration
 * @throws {CsrfTokenMismatchError} If the token is absent, malformed, or wrong
 * @since 0.2.0
 */
export async function verifyWithConfig(
  ctx: IRequestContext,
  config: ResolvedCsrfConfig,
): Promise<void> {
  const expected = readCsrfToken(getSession(ctx));
  if (expected === undefined) {
    throw new CsrfTokenMismatchError('the session carries no CSRF token');
  }

  const submitted = await extractToken(ctx, config);
  if (submitted === undefined) {
    throw new CsrfTokenMismatchError('the request carried no CSRF token');
  }

  if (!timingSafeEqualStrings(expected, submitted)) {
    throw new CsrfTokenMismatchError('the submitted CSRF token did not match the session');
  }
}

/**
 * Pulls the submitted token from the configured header, then the form body.
 *
 * `multipart/form-data` is deliberately not parsed — that would duplicate the
 * storage plugin's multipart parser, which this package may not import. A
 * multipart form must therefore carry the token in the configured header.
 */
async function extractToken(
  ctx: IRequestContext,
  config: ResolvedCsrfConfig,
): Promise<string | undefined> {
  if (config.headerName !== undefined) {
    const fromHeader = ctx.request.headers.get(config.headerName);
    if (fromHeader !== null && fromHeader !== '') {
      return fromHeader;
    }
  }

  const contentType = ctx.request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes(FORM_URLENCODED)) {
    return undefined;
  }

  const body = await ctx.request.text();
  const value = new URLSearchParams(body).get(config.fieldName);
  return value === null || value === '' ? undefined : value;
}
