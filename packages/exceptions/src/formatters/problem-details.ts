/**
 * Shared Problem Details assembly.
 *
 * Both the RFC 9457 formatter and the deprecated RFC 7807 one produce the same
 * body apart from the `type` member, so the assembly lives here once and each
 * formatter supplies only its own {@linkcode ProblemTypeResolver}
 * (AI_GUIDELINES §11.1).
 *
 * This module is internal: `buildProblemDetails` and `ProblemTypeResolver` are
 * not exported from `src/index.ts`. `ERROR_TYPE_BASE` and `ProblemDetails` are
 * re-exported publicly by `rfc9457-formatter.ts`.
 *
 * @module
 */
import type { IRequestContext } from '@setu-ts/common';

import { statusTitle } from '../errors/exceptions.ts';
import { HttpError } from '../errors/http-error.ts';

/**
 * The canonical base URI for framework-produced problem type identifiers.
 *
 * @since 0.1.0
 */
export const ERROR_TYPE_BASE = 'https://setu-ts.dev/errors';

/**
 * The problem type URI identifying a validation failure.
 *
 * Spelled to match the literal `@setu-ts/validation-plugin` emits, so both
 * packages identify the same problem type with the same URI. The two cannot
 * share a constant — a package may not import another package's internals
 * (AI_GUIDELINES §2.2) — so the agreement is pinned by a test in each.
 *
 * @since 0.1.0
 */
export const VALIDATION_TYPE = `${ERROR_TYPE_BASE}/validation`;

/**
 * The RFC 9457 default problem type, meaning "no semantics beyond the HTTP
 * status code" (RFC 9457 §4.2).
 *
 * @since 0.1.0
 */
export const ABOUT_BLANK = 'about:blank';

/**
 * A Problem Details object as defined by
 * [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html).
 *
 * Extension members beyond the five core fields are allowed (RFC 9457 §3.2),
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
 * Marks an {@linkcode HttpError} as one the M70f error responder built, and
 * carries the calling site's disclosure.
 *
 * The responder must hand the disclosure to the Problem Details formatters as
 * the `detail` member while leaving the site's title as the error `message`
 * (which the `default` formatter emits verbatim). It cannot use
 * `HttpError.details` alone as that channel: `details` is a free-form bag an
 * application writes into too, so promoting any `details.detail` would change
 * the body of a thrown error that merely uses the same key name.
 *
 * This marker is a module-private `Symbol` — not `Symbol.for` — because both
 * writer ({@linkcode ../middleware/error-responder-impl.ts}) and reader
 * ({@linkcode buildProblemDetails}) live in this package and import it
 * directly; a global registry key would expose an internal channel that a
 * third party could forge.
 *
 * @internal
 */
export const RESPONDER_DETAIL: unique symbol = Symbol('setu.exceptions.responder-detail');

/**
 * Resolves the `type` member of a Problem Details body.
 *
 * @param statusCode - The HTTP status code of the occurrence
 * @param hasErrors - Whether the error carries a validation `errors` extension
 * @returns The problem type URI
 * @since 0.1.0
 */
export type ProblemTypeResolver = (statusCode: number, hasErrors: boolean) => string;

/**
 * Extracts the validation `errors` extension from an error's `details`, if any.
 *
 * @param error - The HTTP error to read
 * @returns The validation failures, or `undefined` when the error carries none
 */
function extractErrors(error: HttpError): ProblemDetails['errors'] {
  const details = error.details;
  if (details === undefined || !('errors' in details)) {
    return undefined;
  }
  return details.errors as ProblemDetails['errors'];
}

/**
 * Assembles a Problem Details body from a thrown error.
 *
 * - `status` and `detail` come from the {@linkcode HttpError} (or default to
 *   `500` / the error message for generic `Error`s).
 * - `title` is derived from the status code via the shared status-title map.
 * - `instance` is the request path when a context is supplied.
 * - `errors` is included when the error carries validation details.
 * - `type` is delegated to `resolveType`, the only member the two supported
 *   specification versions disagree on.
 *
 * @param error - The thrown error to format
 * @param ctx - Optional request context (used for `instance`)
 * @param resolveType - Strategy supplying the `type` member
 * @returns A Problem Details body
 * @since 0.1.0
 */
export function buildProblemDetails(
  error: Error,
  ctx: IRequestContext | undefined,
  resolveType: ProblemTypeResolver,
): ProblemDetails {
  const isHttp = error instanceof HttpError;
  const statusCode = isHttp ? error.statusCode : 500;
  const errors = isHttp ? extractErrors(error) : undefined;
  // A responder-built error carries the site's disclosure in its structured
  // details under a `detail` key (M70f); the Problem Details `detail` member
  // is that disclosure, falling back to the error message (the title) when a
  // site supplied none.
  //
  // The promotion is gated on {@linkcode RESPONDER_DETAIL}, NOT on the mere
  // presence of a `detail` key, because `HttpError.details` is a free-form bag
  // an application also writes into: reading any `details.detail` would
  // silently change the `detail` member of a thrown
  // `new HttpError(400, 'Invalid payload', { detail: 'code-7' })` from its
  // message to `'code-7'` — a released-behaviour change to every application
  // that happens to use that key name (M70f code review, finding 4). Only an
  // error the responder built carries the marker, so a thrown error keeps the
  // pre-M70f shape: `detail` is the message.
  const carriedDetail = isHttp && RESPONDER_DETAIL in error
    ? (error as HttpError & { [RESPONDER_DETAIL]?: unknown })[RESPONDER_DETAIL]
    : undefined;
  const detail = typeof carriedDetail === 'string' ? carriedDetail : error.message;

  return {
    type: resolveType(statusCode, errors !== undefined),
    title: statusTitle(statusCode),
    status: statusCode,
    detail,
    ...(ctx !== undefined && { instance: ctx.request.path }),
    ...(errors !== undefined && { errors }),
  };
}
