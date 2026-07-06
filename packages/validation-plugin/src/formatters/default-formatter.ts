/**
 * Default and NestJS error formatters.
 *
 * The **default** formatter produces the framework-standard error shape.
 * The **NestJS** formatter produces a body compatible with NestJS's default
 * validation pipe responses.
 *
 * @module
 */
import type { ValidationIssue } from '@hono-enterprise/common';
import type { FormatValidationErrors, ValidationErrorFormatter } from './error-formatter.ts';

/**
 * Framework-standard validation error formatter.
 *
 * Returns a body shaped as:
 *
 * ```json
 * {
 *   "message": "Validation failed with N issue(s).",
 *   "errors": [ { "field": "email", "message": "Invalid email", "code": "invalid_type" } ]
 * }
 * ```
 *
 * @param issues - The validation issues to format
 * @returns The default formatted error body
 */
export const defaultFormatter: ValidationErrorFormatter = (
  issues: readonly ValidationIssue[],
): FormatValidationErrors => {
  return {
    message: `Validation failed with ${issues.length} issue(s).`,
    errors: issues.map((issue) => ({
      field: issue.path,
      message: issue.message,
      ...(issue.code !== undefined && { code: issue.code }),
    })),
  };
};

/**
 * NestJS-compatible validation error formatter.
 *
 * Returns a body shaped as:
 *
 * ```json
 * {
 *   "statusCode": 400,
 *   "message": [ "Invalid email" ],
 *   "error": "Bad Request"
 * }
 * ```
 *
 * When multiple issues exist, the `message` array contains one entry per
 * issue in the format `"field: message"`.
 *
 * @param issues - The validation issues to format
 * @returns The NestJS-compatible formatted error body
 */
export const nestjsFormatter: ValidationErrorFormatter = (
  issues: readonly ValidationIssue[],
): FormatValidationErrors => {
  return {
    statusCode: 400,
    message: issues.map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message),
    error: 'Bad Request',
    errors: issues.map((issue) => ({
      field: issue.path,
      message: issue.message,
      ...(issue.code !== undefined && { code: issue.code }),
    })),
  };
};
