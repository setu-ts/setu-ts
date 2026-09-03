/**
 * The `exceptions` implementation of the request-scoped error responder seam
 * (M70f).
 *
 * This module is **internal**: it is not exported from `src/index.ts`. The
 * interface it satisfies (`IErrorResponder`), the state key, the init type, and
 * the `respondWithError` free function all live in `@setu-ts/common`; exporting
 * the implementation as well would give one concept two public names. A
 * `barrel-exports.test.ts` assertion pins that it stays out of the barrel.
 *
 * @module
 */
import type {
  ErrorResponderTarget,
  ErrorResponseInit,
  IErrorResponder,
  IRequestContext,
} from '@setu-ts/common';

import { HttpError } from '../errors/http-error.ts';
import { RESPONDER_DETAIL } from '../formatters/problem-details.ts';
import type { ErrorHandlerFormatter } from '../formatters/error-formatter.ts';

/**
 * The `application/problem+json` content type for Problem Details responses.
 *
 * Mirrors the constant `errorHandler` uses to decide the media type: a
 * formatter answers Problem Details (and so derives `instance` from the
 * request path) exactly when its resolved content type is this one.
 */
const PROBLEM_JSON = 'application/problem+json';

/**
 * Narrows an {@linkcode ErrorResponderTarget} to a full {@linkcode
 * IRequestContext} when it genuinely is one.
 *
 * The responder is reached two ways. In-pipeline sites — the kernel's terminals
 * and every short-circuiting middleware — pass the live `IRequestContext`,
 * which carries `id`, `services`, and `startTime`. The kernel's PRE-pipeline
 * sites — the shutdown-drain `503` and the malformed-request `400` — pass a
 * bare target of just `state`, `response`, and an optional safe `request`
 * path, because no request context exists yet. The three members checked here
 * are present on every real context and absent from every bare target, so the
 * test distinguishes the two without a lie.
 *
 * @param target - The responder target to test
 * @returns `true` when the target is a full request context
 */
function isFullRequestContext(target: ErrorResponderTarget): target is IRequestContext {
  const ctx = target as IRequestContext;
  return (
    typeof ctx.id === 'string' &&
    typeof ctx.services === 'object' &&
    ctx.services !== null &&
    typeof ctx.startTime === 'number'
  );
}

/**
 * Builds the {@linkcode HttpError} that carries one error response's status,
 * title and disclosure.
 *
 * This is the single owner of that mapping, and it has **two** callers: the
 * responder below, and `errorHandler`'s status-hint path (M89b), which answers
 * a thrown error branded with an `HttpStatusHint` — a type that IS an
 * `ErrorResponseInit`. Sharing it is what makes the two agree: a hinted throw
 * and a `respondWithError` call carrying the same values produce byte-identical
 * bodies under `default`, `rfc9457`, `rfc7807` and any custom formatter. A
 * second hand-rolled construction would silently diverge — the `default`
 * formatter reads `details.detail` while the Problem Details formatters read
 * the {@linkcode RESPONDER_DETAIL} symbol, so getting either half wrong loses
 * the disclosure in exactly one format.
 *
 * @param init - The status, title, disclosure and optional structured details
 * @returns An `HttpError` every formatter renders with the disclosure intact
 */
export function buildErrorFromInit(init: ErrorResponseInit): HttpError {
  // The title is the framework-default `error` member — the `message` of the
  // `default` format and the `detail` fallback of the Problem Details
  // formatters — so it stays `error.message`. The disclosure (`init.detail`)
  // is kept verbatim by every format (the `ErrorResponseInit` contract in
  // `@setu-ts/common`): it is carried in the error's structured `details`
  // under a `detail` key, so the `default` format emits it as `details.detail`
  // beside `message`, and `buildProblemDetails` promotes it to the Problem
  // Details `detail` member (falling back to the title when a site supplies no
  // disclosure). `init.details` (e.g. a validation `errors` array) is merged
  // through unchanged. Carrying it this way — rather than in `error.message` —
  // keeps the title verbatim, which a site's (non-)disclosure decision depends
  // on.
  const details = init.detail !== undefined
    ? { ...init.details, detail: init.detail }
    : init.details;
  const error = new HttpError(init.status, init.title, details);
  // Mark the error as responder-built and carry the disclosure on a
  // module-private symbol, which is what `buildProblemDetails` promotes to the
  // Problem Details `detail` member. The `details.detail` key above is what the
  // `default` formatter emits (it serializes `details` verbatim); the Problem
  // Details formatters read the symbol instead, so a THROWN error that happens
  // to carry a `details.detail` key of its own keeps `detail: <message>` (M70f
  // code review, finding 4). Non-enumerable so it never reaches a serialized
  // body.
  if (init.detail !== undefined) {
    Object.defineProperty(error, RESPONDER_DETAIL, {
      value: init.detail,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  return error;
}

/**
 * Builds an {@linkcode IErrorResponder} from the formatter and content type
 * that `errorHandler` has **already** resolved at factory time.
 *
 * The responder keeps the `HttpError` construction inside the only package that
 * owns it: it builds an `HttpError` from the init (so `buildProblemDetails` sees
 * a real `statusCode` and the validation `errors` extension, and
 * `maskInternalErrors` would never mask a deliberately 4xx), runs the resolved
 * formatter over it, and writes status, `content-type` and the serialized body
 * — the same three-step tail `errorHandler`'s catch path performs.
 *
 * @param formatter - The resolved error formatter
 * @param contentType - The resolved response content type
 * @returns A responder publishing the application's error format
 * @since 0.1.0
 */
export function createErrorResponder(
  formatter: ErrorHandlerFormatter,
  contentType: string,
): IErrorResponder {
  return {
    respond(target: ErrorResponderTarget, init: ErrorResponseInit): void {
      const error = buildErrorFromInit(init);
      // The formatter's `ctx` parameter is a FULL `IRequestContext` by its
      // contract (M70f re-review round 2, finding 2). The target is a full
      // context only at the in-pipeline sites; the kernel's pre-pipeline sites
      // hand over a bare target whose `services`, `id`, `params`, `query`,
      // `signal` and `startTime` do not exist. Passing that partial object
      // would let a custom formatter read a documented member and throw
      // `TypeError: Cannot read properties of undefined` — replacing the
      // configured 503/400 with an unhandled exception. So the formatter
      // receives the context only when it genuinely is one, and `undefined`
      // otherwise — the value its optional `ctx` parameter already declares.
      const fullContext = isFullRequestContext(target) ? target : undefined;
      let body = formatter(error, fullContext);
      // The Problem Details `instance` member comes from the request path. At
      // the in-pipeline sites the formatter read it off the full context; at
      // the pre-pipeline sites there is no context, so the responder supplies
      // the safe path the kernel captured separately — a separate internal
      // mechanism, since the formatter's optional `ctx` parameter is the only
      // public channel and it must stay honest (M70f re-review round 2,
      // finding 2). A malformed request carries no path, in which case the
      // member is simply absent. A fresh object is composed rather than
      // mutating the formatter's return value, which a custom formatter may
      // share or freeze.
      if (
        fullContext === undefined &&
        contentType === PROBLEM_JSON &&
        target.request !== undefined
      ) {
        body = { ...body, instance: target.request.path };
      }
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      target.response
        .status(init.status)
        .header('content-type', contentType)
        .send(bytes);
    },
  };
}
