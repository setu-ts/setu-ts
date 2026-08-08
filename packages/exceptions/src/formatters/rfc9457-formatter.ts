/**
 * RFC 9457 Problem Details error formatter.
 *
 * Produces a JSON body conforming to
 * [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) Problem Details for
 * HTTP APIs, which obsoletes RFC 7807. The body carries `type`, `title`,
 * `status`, and `detail`, with `instance` derived from the request path and an
 * optional `errors` extension for validation failures.
 *
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';

import type { ErrorHandlerFormatter } from './error-formatter.ts';
import {
  ABOUT_BLANK,
  buildProblemDetails,
  type ProblemDetails,
  VALIDATION_TYPE,
} from './problem-details.ts';

export { ERROR_TYPE_BASE } from './problem-details.ts';
export type { ProblemDetails } from './problem-details.ts';

/**
 * Resolves the RFC 9457 `type` member.
 *
 * An {@linkcode HttpError} carries no problem-type identity beyond its status
 * code, so a URI minted from that status would identify nothing the `status`
 * member does not already convey — which is exactly the case RFC 9457 §4.2
 * registers `about:blank` for. The one exception is the body produced by
 * `validationError()`, which defines an `errors` extension member and is
 * therefore a distinct problem type deserving its own URI.
 *
 * @param _statusCode - The HTTP status code (not used; the status member carries it)
 * @param hasErrors - Whether the error carries a validation `errors` extension
 * @returns `about:blank`, or the validation problem type URI
 */
const resolveRfc9457Type = (_statusCode: number, hasErrors: boolean): string =>
  hasErrors ? VALIDATION_TYPE : ABOUT_BLANK;

/**
 * Format an error as RFC 9457 Problem Details.
 *
 * `type` is `about:blank` for problems whose only semantics are their status
 * code, and the framework validation problem type when the error carries an
 * `errors` extension. Every other member is assembled identically to the
 * deprecated RFC 7807 formatter.
 *
 * @param error - The thrown error to format
 * @param ctx - Optional request context (used for `instance`)
 * @returns An RFC 9457 Problem Details body
 * @example
 * ```typescript
 * rfc9457Formatter(notFound('User 42 does not exist'), ctx);
 * // {
 * //   type: 'about:blank',
 * //   title: 'Not Found',
 * //   status: 404,
 * //   detail: 'User 42 does not exist',
 * //   instance: '/users/42',
 * // }
 * ```
 * @since 0.1.0
 */
export const rfc9457Formatter: ErrorHandlerFormatter = (
  error: Error,
  ctx?: IRequestContext,
): ProblemDetails => buildProblemDetails(error, ctx, resolveRfc9457Type);
