/**
 * Error formatter selector — resolves the error format to a concrete
 * {@link FormatValidationErrors} function.
 *
 * Supported formats:
 * - `'default'` — Framework-standard error shape (from default-formatter)
 * - `'rfc7807'` — RFC 7807 Problem Details (from rfc7807-formatter)
 * - `'nestjs'` — NestJS-compatible error shape (from default-formatter)
 * - A custom function — used as-is
 *
 * @module
 */
import type { IRequestContext, ValidationIssue } from '@hono-enterprise/common';
import { defaultFormatter, nestjsFormatter } from './default-formatter.ts';
import { rfc7807Formatter } from './rfc7807-formatter.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The shaped error body produced by a validation error formatter.
 *
 * @since 0.1.0
 */
export interface FormatValidationErrors {
  /** Array of formatted error entries. */
  errors: readonly FormattedError[];
  /** Human-readable summary message (optional; present on default/nestjs, omitted on rfc7807). */
  message?: string | string[];
  /** Additional formatter-specific properties. */
  [key: string]: unknown;
}

/**
 * A single formatted error entry.
 *
 * @since 0.1.0
 */
export interface FormattedError {
  /** Dot-separated field path. */
  field: string;
  /** Human-readable message. */
  message: string;
  /** Optional machine-readable error code. */
  code?: string;
}

/**
 * The built-in error format identifiers.
 *
 * @since 0.1.0
 */
export type ErrorFormat = 'default' | 'rfc7807' | 'nestjs';

/**
 * A function that formats validation issues into a structured error body.
 *
 * @param issues - The validation issues to format
 * @param ctx - Optional request context (allows formatters to set dynamic fields like `instance`)
 * @returns The formatted error body
 * @since 0.1.0
 */
export type ValidationErrorFormatter = (
  issues: readonly ValidationIssue[],
  ctx?: IRequestContext,
) => FormatValidationErrors;

// ---------------------------------------------------------------------------
// Formatter selector
// ---------------------------------------------------------------------------

/**
 * Resolve the error format configuration to a concrete formatter function.
 *
 * - When `format` is `'default'`, `'rfc7807'`, or `'nestjs'` the corresponding
 *   built-in formatter is returned.
 * - When `format` is already a function, it is returned as-is.
 * - Otherwise a `TypeError` is thrown.
 *
 * @param format - The error format identifier or custom formatter function
 * @returns The resolved formatter function
 * @throws {TypeError} When an unknown format is provided
 */
export function resolveFormatter(
  format: ErrorFormat | ValidationErrorFormatter = 'default',
): ValidationErrorFormatter {
  if (typeof format === 'function') {
    return format;
  }

  switch (format) {
    case 'default':
      return defaultFormatter;
    case 'rfc7807':
      return rfc7807Formatter;
    case 'nestjs':
      return nestjsFormatter;
    default:
      throw new TypeError(`Unknown error format: "${format}"`);
  }
}
