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
import { formEncodingOf, parseFormBody } from '@setu-ts/common';

import { timingSafeEqualStrings } from '../codec/timing-safe.ts';
import { CsrfTokenMismatchError } from '../errors.ts';
import type { CsrfFormOptions, ResolvedCsrfConfig } from '../options.ts';
import { resolveCsrfConfig } from '../options.ts';
import { getSession } from '../services/get-session.ts';
import { readCsrfToken } from './token.ts';
import { isCsrfExcluded } from './exclude.ts';

/**
 * Verifies the request's CSRF token against the session's, throwing on any
 * mismatch.
 *
 * Exported so a handler or framework action can validate inline — React Router
 * actions conventionally do their own validation rather than relying on
 * middleware. The middleware calls exactly this function, so the two can never
 * disagree.
 *
 * Reading the body here is safe: every body read is memoized (M87), so the
 * parse is cached and the handler can still read the body afterwards —
 * including a multipart body, which is read now too (M94b) through the same
 * shared accessor the upload middleware uses. The configured header is read
 * first, so a client that sends the token in the header triggers no body read
 * at all.
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
  if (isCsrfExcluded(ctx, options.exclude)) return;
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
 * Both form encodings are read (M94b) through the request's `formData`
 * accessor — falling back to the same shared `parseFormBody` when the request
 * omits the optional accessor — so a token arriving in a multipart FIELD now
 * verifies, where previously only the header could carry it. The content-type
 * is classified first with `formEncodingOf`, so a non-form request never
 * parses a body and never observes the accessor's `415`: it simply reports
 * "carried no CSRF token", the mismatch it always reported.
 *
 * A value is accepted only when it is a non-empty STRING. That check is a
 * security requirement, not tidiness: a client chooses freely whether a part
 * carries a `filename`, so a `FormFile` can be submitted under the token's
 * field name, and handing a non-string to `timingSafeEqualStrings` would
 * compare garbage. A file-borne token is refused as absent.
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

  const contentType = ctx.request.headers.get('content-type');
  if (formEncodingOf(contentType) === undefined) {
    return undefined;
  }

  const form = ctx.request.formData !== undefined
    ? await ctx.request.formData()
    : parseFormBody(await ctx.request.bytes(), contentType);
  const value = form.get(config.fieldName);
  return typeof value === 'string' && value !== '' ? value : undefined;
}
