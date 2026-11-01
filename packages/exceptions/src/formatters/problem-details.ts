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
import type { IRequestContext, ProblemTypeInit } from '@setu-ts/common';

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
export const VALIDATION_TYPE: string = `${ERROR_TYPE_BASE}/validation`;

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
 * Marks an {@linkcode HttpError} as one the M70f error responder built with a
 * {@linkcode ProblemTypeInit}, and carries that problem type.
 *
 * The responder hands a site's `problem` init to the Problem Details formatters
 * so they emit its `type` and `title` instead of the status-derived ones and
 * merge its `extensions`. It cannot travel through `HttpError.details`: that is
 * a free-form bag an application writes into, so promoting a `details.problem`
 * would change the body of a thrown error that merely uses the same key name.
 *
 * Like {@linkcode RESPONDER_DETAIL}, this marker is a module-private `Symbol`
 * — not `Symbol.for` — because both writer
 * ({@linkcode ../middleware/error-responder-impl.ts}) and reader
 * ({@linkcode buildProblemDetails}) live in this package and import it
 * directly; a global registry key would expose an internal channel that a
 * third party could forge.
 *
 * @internal
 */
export const RESPONDER_PROBLEM: unique symbol = Symbol('setu.exceptions.responder-problem');

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
 *   specification versions disagree on — unless the error was built with a
 *   {@linkcode ProblemTypeInit}, whose `type` and `title` replace them and
 *   whose `extensions` are merged in without overriding a core member.
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
  const carriedDetail =
    isHttp && RESPONDER_DETAIL in error
      ? (error as HttpError & { [RESPONDER_DETAIL]?: unknown })[RESPONDER_DETAIL]
      : undefined;
  const detail = typeof carriedDetail === 'string' ? carriedDetail : error.message;
  // A responder-built error may also carry a problem type (a rate limiter's
  // `quota-exceeded`, for instance). Read on the same marker discipline as the
  // disclosure: only the responder's own error carries it, so a thrown
  // `HttpError` never acquires a problem type it did not ask for.
  const carriedProblem =
    isHttp && RESPONDER_PROBLEM in error
      ? (error as HttpError & { [RESPONDER_PROBLEM]?: unknown })[RESPONDER_PROBLEM]
      : undefined;
  if (isProblemTypeInit(carriedProblem)) {
    // Extensions never carry a core member's name (RFC 9457 §3.2), even when
    // that member is absent from this body — see `extensionMembers`.
    return {
      ...extensionMembers(carriedProblem.extensions),
      type: carriedProblem.type,
      title: carriedProblem.title,
      status: statusCode,
      detail,
      ...(ctx !== undefined && { instance: ctx.request.path }),
      ...(errors !== undefined && { errors }),
    };
  }

  return {
    type: resolveType(statusCode, errors !== undefined),
    title: statusTitle(statusCode),
    status: statusCode,
    detail,
    ...(ctx !== undefined && { instance: ctx.request.path }),
    ...(errors !== undefined && { errors }),
  };
}

/**
 * The Problem Details members the framework owns. An extension is never
 * emitted under one of these names, even when the core member itself is absent
 * from a given body (`instance` without a context, `errors` without validation
 * failures, `stack` unless `errorHandler` adds it), so an extension cannot
 * stand in for one.
 */
const CORE_MEMBERS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'errors',
  'stack',
]);

/**
 * Returns a problem's extension members minus any that share a core member's
 * name.
 *
 * Building and reading the object is guarded because an extension is arbitrary
 * caller-supplied data: a throwing getter, a throwing `toJSON`, a revoked
 * `Proxy`, a `BigInt`, or a cycle must drop the extensions rather than make the
 * error response itself throw. The JSON round-trip is deliberate — it runs every
 * `toJSON` and getter HERE, inside the guard, so `errorHandler`'s later
 * `JSON.stringify` of the body cannot throw on an extension. `JSON.parse`
 * defines `__proto__` as an own data property, so an extension named
 * `__proto__` stays an ordinary member rather than setting a prototype.
 */
function extensionMembers(
  extensions: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (extensions === undefined) return {};
  try {
    const filtered = Object.fromEntries(
      Object.entries(extensions).filter(([key]) => !CORE_MEMBERS.has(key)),
    );
    const serialized = JSON.stringify(filtered);
    if (typeof serialized !== 'string') return {};
    const roundTripped: unknown = JSON.parse(serialized);
    if (typeof roundTripped !== 'object' || roundTripped === null || Array.isArray(roundTripped)) {
      return {};
    }
    return roundTripped as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Narrows the carried marker value to a {@linkcode ProblemTypeInit}.
 *
 * The writer always supplies a conforming value; the guard exists because the
 * property is read through a cast, and a malformed one must fall back to the
 * status-derived body rather than emit `type: undefined`.
 */
function isProblemTypeInit(value: unknown): value is ProblemTypeInit {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProblemTypeInit).type === 'string' &&
    typeof (value as ProblemTypeInit).title === 'string'
  );
}
