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
import type { ErrorHandlerFormatter } from '../formatters/error-formatter.ts';

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
      const error = new HttpError(init.status, init.title, init.details);
      // The responder is only reachable through a value `errorHandler` published
      // with a full request context, so the structural target is a full
      // `IRequestContext` at the call site. The formatter reads only
      // `ctx.request.path` (for the Problem Details `instance`); the cast is the
      // boundary between the subset `common` names and the full context.
      const body = formatter(error, target as IRequestContext);
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      target.response
        .status(init.status)
        .header('content-type', contentType)
        .send(bytes);
    },
  };
}
