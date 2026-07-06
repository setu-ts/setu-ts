/**
 * Exception factory functions.
 *
 * Each factory returns a {@linkcode HttpError} with a fixed `statusCode`,
 * embodying **composition over inheritance** (AI_GUIDELINES §1.4,
 * ARCHITECTURE.md §13). Throw one in a route handler or service and the
 * error-handler middleware will format and send it with the right status.
 *
 * @example
 * ```typescript
 * import { notFound, badRequest } from '@hono-enterprise/exceptions';
 *
 * function getUser(id: string) {
 *   if (!id) throw badRequest('id is required');
 *   const user = db.find(id);
 *   if (!user) throw notFound(`User ${id} not found`);
 *   return user;
 * }
 * ```
 *
 * @module
 */
import { HttpError } from './http-error.ts';
import type { ValidationError } from './http-error.ts';

// ---------------------------------------------------------------------------
// Status-code → human title (single source of truth, shared with formatters)
// ---------------------------------------------------------------------------

/**
 * A human-readable title for a given HTTP status code. This is the single
 * source of truth used by both the factory functions and the RFC 7807
 * formatter so the `title` field never drifts from the produced `statusCode`.
 *
 * Keys are the status codes the factories below produce.
 *
 * @since 0.1.0
 */
export const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/**
 * Resolves the human-readable title for a status code, falling back to a
 * generic title for codes outside the well-known set.
 *
 * @param statusCode - The HTTP status code
 * @returns A human-readable title
 * @since 0.1.0
 */
export function statusTitle(statusCode: number): string {
  return STATUS_TITLES[statusCode] ?? 'Error';
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Creates a `400 Bad Request` error.
 *
 * @param message - Human-readable error message
 * @param details - Optional structured details appended to the error body
 * @returns A `400` {@linkcode HttpError}
 * @since 0.1.0
 */
export function badRequest(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): HttpError {
  return new HttpError(400, message, details);
}

/**
 * Creates a `401 Unauthorized` error.
 *
 * @param message - Human-readable error message
 * @returns A `401` {@linkcode HttpError}
 * @since 0.1.0
 */
export function unauthorized(message: string): HttpError {
  return new HttpError(401, message);
}

/**
 * Creates a `403 Forbidden` error.
 *
 * @param message - Human-readable error message
 * @returns A `403` {@linkcode HttpError}
 * @since 0.1.0
 */
export function forbidden(message: string): HttpError {
  return new HttpError(403, message);
}

/**
 * Creates a `404 Not Found` error.
 *
 * @param message - Human-readable error message
 * @returns A `404` {@linkcode HttpError}
 * @since 0.1.0
 */
export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

/**
 * Creates a `409 Conflict` error.
 *
 * @param message - Human-readable error message
 * @returns A `409` {@linkcode HttpError}
 * @since 0.1.0
 */
export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

/**
 * Creates a `422 Unprocessable Entity` error wrapping a list of validation
 * failures.
 *
 * The `errors` array is stored in the error's `details.errors` so it survives
 * serialization into both the default and RFC 7807 error bodies.
 *
 * @param errors - The validation failures that caused this error
 * @param message - Optional custom message (defaults to a count-based summary)
 * @returns A `422` {@linkcode HttpError}
 * @since 0.1.0
 */
export function validationError(
  errors: readonly ValidationError[],
  message?: string,
): HttpError {
  const summary = message ?? `Validation failed with ${errors.length} error(s).`;
  return new HttpError(422, summary, { errors });
}

/**
 * Creates a `429 Too Many Requests` error.
 *
 * @param message - Human-readable error message
 * @param details - Optional structured details (e.g. `retryAfter`)
 * @returns A `429` {@linkcode HttpError}
 * @since 0.1.0
 */
export function tooManyRequests(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): HttpError {
  return new HttpError(429, message, details);
}

/**
 * Creates a `500 Internal Server Error` error.
 *
 * Pass the original error as `cause` so the root cause is preserved in the
 * ES2022 error chain for logging and debugging.
 *
 * @param message - Human-readable error message
 * @param cause - Optional underlying error forwarded to the cause chain
 * @returns A `500` {@linkcode HttpError}
 * @since 0.1.0
 */
export function internalServerError(message: string, cause?: Error): HttpError {
  return new HttpError(500, message, undefined, cause);
}

/**
 * Creates a `501 Not Implemented` error.
 *
 * @param message - Human-readable error message
 * @returns A `501` {@linkcode HttpError}
 * @since 0.1.0
 */
export function notImplemented(message: string): HttpError {
  return new HttpError(501, message);
}

/**
 * Creates a `503 Service Unavailable` error.
 *
 * @param message - Human-readable error message
 * @returns A `503` {@linkcode HttpError}
 * @since 0.1.0
 */
export function serviceUnavailable(message: string): HttpError {
  return new HttpError(503, message);
}
