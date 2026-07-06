/**
 * Error format selector — resolves the configured error format to a concrete
 * formatter function.
 *
 * Supported formats:
 * - `'default'` — Framework-standard error shape (`statusCode`, `message`,
 *   optional `details`).
 * - `'rfc7807'` — RFC 7807 Problem Details (see `rfc7807-formatter.ts`).
 * - A custom function — used as-is.
 *
 * @module
 */
import type { IRequestContext } from '@hono-enterprise/common';

import { rfc7807Formatter } from './rfc7807-formatter.ts';
import { HttpError } from '../errors/http-error.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A function that formats a thrown error into a serializable error body.
 *
 * @param error - The thrown error (an `HttpError` or a generic `Error`)
 * @param ctx - Optional request context (used for `instance`, logging, etc.)
 * @returns The formatted error body
 * @since 0.1.0
 */
export type ErrorHandlerFormatter = (
  error: Error,
  ctx?: IRequestContext,
) => Record<string, unknown>;

/**
 * The built-in error format identifiers.
 *
 * @since 0.1.0
 */
export type ErrorFormat = 'default' | 'rfc7807';

// ---------------------------------------------------------------------------
// Built-in default formatter
// ---------------------------------------------------------------------------

/**
 * The framework-standard error body shape.
 *
 * @since 0.1.0
 */
export interface DefaultErrorBody {
  /** The HTTP status code. */
  readonly statusCode: number;
  /** Human-readable error message. */
  readonly message: string;
  /** Optional structured details (present when the error carries any). */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Optional stack trace (present only when `includeStackTrace` is on). */
  readonly stack?: string;
  /** Allow callers to attach further members. */
  readonly [key: string]: unknown;
}

/**
 * Framework-standard error formatter.
 *
 * Returns a body shaped as:
 *
 * ```json
 * { "statusCode": 404, "message": "User not found", "details": { ... } }
 * ```
 *
 * Generic (non-`HttpError`) errors map to `500`.
 *
 * @param error - The thrown error to format
 * @returns The default formatted error body
 * @since 0.1.0
 */
export const defaultFormatter: ErrorHandlerFormatter = (error: Error): DefaultErrorBody => {
  const isHttp = error instanceof HttpError;
  return {
    statusCode: isHttp ? error.statusCode : 500,
    message: error.message,
    ...(isHttp && error.details !== undefined && { details: error.details }),
  };
};

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

/**
 * Resolve the error format configuration to a concrete formatter function.
 *
 * - When `format` is `'default'` or `'rfc7807'`, the corresponding built-in
 *   formatter is returned.
 * - When `format` is already a function, it is returned as-is.
 * - Otherwise a `TypeError` is thrown.
 *
 * @param format - The error format identifier or custom formatter function
 * @returns The resolved formatter function
 * @throws {TypeError} When an unknown format string is provided
 * @since 0.1.0
 */
export function selectFormatter(
  format: ErrorFormat | ErrorHandlerFormatter = 'default',
): ErrorHandlerFormatter {
  if (typeof format === 'function') {
    return format;
  }
  switch (format) {
    case 'default':
      return defaultFormatter;
    case 'rfc7807':
      return rfc7807Formatter;
    default:
      throw new TypeError(`Unknown error format: "${format}"`);
  }
}
