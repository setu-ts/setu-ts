/**
 * RFC 7807 Problem Details error formatter.
 *
 * Produces a Problem Details body as defined in RFC 7807.
 *
 * @module
 */
import type { IRequestContext, ValidationIssue } from '@hono-enterprise/common';
import type { FormatValidationErrors, ValidationErrorFormatter } from './error-formatter.ts';

/**
 * Format validation issues as RFC 7807 Problem Details.
 *
 * @param issues - The validation issues to format
 * @returns The RFC 7807 formatted error body
 */
export const rfc7807Formatter: ValidationErrorFormatter = (
  issues: readonly ValidationIssue[],
  ctx?: IRequestContext,
): FormatValidationErrors => {
  return {
    type: 'https://hono-enterprise.dev/errors/validation',
    title: 'Validation Error',
    status: 400,
    detail: `The request contains ${issues.length} validation error(s).`,
    // RFC 7807 §3.1: `instance` is a URI reference. Omit it when there is no
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
