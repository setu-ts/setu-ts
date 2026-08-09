/**
 * RFC 9457 Problem Details validation error formatter.
 *
 * Produces a Problem Details body as defined in
 * [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html), which obsoletes
 * RFC 7807.
 *
 * Unlike the formatter in `@setu-ts/exceptions`, this one always emits a
 * concrete `type` URI rather than `about:blank`: a validation failure carries
 * an `errors` extension member and is therefore a distinct problem type with
 * semantics beyond its status code (RFC 9457 §4.2). The body is consequently
 * unchanged from the RFC 7807 era — it was already valid under RFC 9457.
 *
 * @module
 */
import type { IRequestContext, ValidationIssue } from '@setu-ts/common';
import type { FormatValidationErrors, ValidationErrorFormatter } from './error-formatter.ts';

/**
 * The problem type URI identifying a validation failure.
 *
 * Spelled to match the literal `@setu-ts/exceptions` emits for the same problem
 * type. The two cannot share a constant — a package may not import another
 * package's internals (AI_GUIDELINES §2.2) — so the agreement is pinned by a
 * test in each.
 */
const VALIDATION_TYPE = 'https://setu-ts.dev/errors/validation';

/**
 * Format validation issues as RFC 9457 Problem Details.
 *
 * @param issues - The validation issues to format
 * @param ctx - Optional request context (used for `instance`)
 * @returns The RFC 9457 formatted error body
 * @since 0.1.0
 */
export const rfc9457Formatter: ValidationErrorFormatter = (
  issues: readonly ValidationIssue[],
  ctx?: IRequestContext,
): FormatValidationErrors => {
  return {
    type: VALIDATION_TYPE,
    title: 'Validation Error',
    status: 400,
    detail: `The request contains ${issues.length} validation error(s).`,
    // RFC 9457 §3.1: `instance` is a URI reference. Omit it when there is no
    // request context rather than emitting an empty string, matching the
    // exceptions package's formatter for the same spec.
    ...(ctx !== undefined && { instance: ctx.request.path }),
    errors: issues.map((issue) => ({
      field: issue.path,
      message: issue.message,
      ...(issue.code !== undefined && { code: issue.code }),
    })),
  };
};
