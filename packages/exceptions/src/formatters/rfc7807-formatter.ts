/**
 * RFC 7807 Problem Details error formatter (deprecated).
 *
 * RFC 7807 was obsoleted by [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
 * in July 2023. This formatter is retained unchanged so existing callers keep
 * their exact body shape through a deprecation period (AI_GUIDELINES §9.2); new
 * code should use `rfc9457-formatter.ts`.
 *
 * It differs from the RFC 9457 formatter in the `type` member alone: this one
 * mints a URI from the status code for every error, which RFC 9457 §4.2 replaces
 * with `about:blank` for problems carrying no semantics beyond that status.
 *
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';

import type { ErrorHandlerFormatter } from './error-formatter.ts';
import { buildProblemDetails, ERROR_TYPE_BASE, type ProblemDetails } from './problem-details.ts';

/**
 * Resolves the RFC 7807 `type` member: a URI minted from the status code.
 *
 * @param statusCode - The HTTP status code of the occurrence
 * @returns The status-derived problem type URI
 */
const resolveRfc7807Type = (statusCode: number): string => `${ERROR_TYPE_BASE}/${statusCode}`;

/**
 * Format an error as RFC 7807 Problem Details.
 *
 * @param error - The thrown error to format
 * @param ctx - Optional request context (used for `instance`)
 * @returns An RFC 7807 Problem Details body
 * @deprecated RFC 7807 was obsoleted by RFC 9457. Use `rfc9457Formatter`
 * instead, or the `'rfc9457'` format alias. Will be removed in v1.0.0.
 * @example
 * ```typescript
 * // Before
 * app.middleware.add(errorHandler({ format: 'rfc7807' }));
 * // After — `type` becomes 'about:blank' for status-only problems
 * app.middleware.add(errorHandler({ format: 'rfc9457' }));
 * ```
 * @since 0.1.0
 */
export const rfc7807Formatter: ErrorHandlerFormatter = (
  error: Error,
  ctx?: IRequestContext,
): ProblemDetails => buildProblemDetails(error, ctx, resolveRfc7807Type);
