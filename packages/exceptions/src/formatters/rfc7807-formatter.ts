/**
 * RFC 7807 Problem Details error formatter.
 *
 * Produces a JSON body conforming to [RFC 7807](https://datatracker.ietf.org/doc/html/rfc7807)
 * Problem Details for HTTP APIs. The body carries `type`, `title`, `status`,
 * and `detail`, with `instance` derived from the request path and an optional
 * `errors` extension for validation failures.
 *
 * @module
 */
import type { IRequestContext } from '@hono-enterprise/common';

import type { ErrorHandlerFormatter } from './error-formatter.ts';
import { statusTitle } from '../errors/exceptions.ts';
import { HttpError } from '../errors/http-error.ts';

/**
 * The canonical base URI for framework-produced error type identifiers.
 *
 * @since 0.1.0
 */
export const ERROR_TYPE_BASE = 'https://hono-enterprise.dev/errors';

/**
 * A RFC 7807 Problem Details object.
 *
 * Extension members beyond the standard fields are allowed (RFC 7807 §3.1),
 * so `errors` and `stack` may be present.
 *
 * @since 0.1.0
 */
export interface ProblemDetails {
  /** A URI reference identifying the problem type. */
  readonly type: string;
  /** A short, human-readable summary of the problem type. */
  readonly title: string;
  /** The HTTP status code generated for this occurrence. */
  readonly status: number;
  /** A human-readable explanation specific to this occurrence. */
  readonly detail: string;
  /** A URI reference identifying the specific occurrence (request path). */
  readonly instance?: string;
  /** Optional validation failures extension (present for `422` errors). */
  readonly errors?: ReadonlyArray<{
    field: string;
    message: string;
    code?: string;
  }>;
  /** Optional stack trace (present only when `includeStackTrace` is on). */
  readonly stack?: string;
  /** Allow callers to attach further extension members. */
  readonly [key: string]: unknown;
}

/**
 * Format an error as RFC 7807 Problem Details.
 *
 * - `status` and `detail` come from the {@linkcode HttpError} (or default to
 *   `500` / the error message for generic `Error`s).
 * - `title` is derived from the status code via the shared status-title map.
 * - `instance` is the request path when a context is supplied.
 * - `errors` is included when the error carries validation details.
 *
 * @param error - The thrown error to format
 * @param ctx - Optional request context (used for `instance`)
 * @returns A RFC 7807 Problem Details body
 * @since 0.1.0
 */
export const rfc7807Formatter: ErrorHandlerFormatter = (
  error: Error,
  ctx?: IRequestContext,
): ProblemDetails => {
  const isHttp = error instanceof HttpError;
  const statusCode = isHttp ? error.statusCode : 500;
  const hasErrors = isHttp && error.details !== undefined && 'errors' in error.details;

  return {
    type: `${ERROR_TYPE_BASE}/${statusCode}`,
    title: statusTitle(statusCode),
    status: statusCode,
    detail: error.message,
    ...(ctx !== undefined && { instance: ctx.request.path }),
    ...(hasErrors && {
      errors: (error as HttpError).details!.errors as ReadonlyArray<{
        field: string;
        message: string;
        code?: string;
      }>,
    }),
  };
};
