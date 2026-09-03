/**
 * The HTTP status hint: a symbol-keyed brand that lets a package which may not
 * import `@setu-ts/exceptions` state how its own error should be answered.
 *
 * A plugin that throws from deep inside a data source holds no
 * `IRequestContext`, so the M70f `respondWithError` seam — which needs one —
 * cannot reach it. Such
 * an error therefore reaches `errorHandler` as a plain `Error`, is normalized
 * to a `500`, and is masked. That is correct for a driver fault and wrong for
 * a refusal the caller caused: the condition is permanent, the cause is the
 * request, and the useful sentence ends up log-only.
 *
 * Branding the error carries the decision to the one reader that has the
 * context. `@setu-ts/database-plugin` brands its three query-shape refusals;
 * `errorHandler` reads the brand before it wraps a non-`HttpError`.
 *
 * @module
 */
import type { ErrorResponseInit } from './error-responder.ts';

/**
 * Key under which an `Error` carries its {@linkcode HttpStatusHint}.
 *
 * Created with `Symbol.for`, not `Symbol()`, so two copies of this package in
 * one process resolve the same key — the failure mode a locally-constructed
 * symbol would produce silently, since every read would simply miss. This is
 * the `SECURITY_METADATA` precedent (M57).
 *
 * Prefer {@linkcode withHttpStatusHint} and {@linkcode httpStatusHintOf} over
 * touching this directly; the symbol is exported so an error thrown outside
 * this repository can be branded too.
 *
 * @since 0.4.0
 */
export const HTTP_STATUS_HINT: unique symbol = Symbol.for('setu.http.status-hint');

/**
 * How an error should be answered, as decided by the code that threw it.
 *
 * It is an {@linkcode ErrorResponseInit} — the same shape
 * {@linkcode respondWithError} takes — because it says the same thing: the
 * status, title and disclosure of one error response. Reusing it is what lets
 * `@setu-ts/exceptions` build the response body through ONE implementation, so
 * a hinted throw and a `respondWithError` call carrying the same values answer
 * byte-identically under every configured format.
 *
 * `detail` is **required, and that is the point.** The brand does not serve
 * the `Error`'s own `message`: a message is written for an operator and may
 * quote a statement, a bound parameter or a driver's own text, which is
 * exactly the disclosure `maskInternalErrors` exists to stop (X12-3). Making
 * the caller-facing sentence an explicit act at the brand site keeps
 * caller-safety a decision rather than an inference, so a hinted response can
 * be exempted from masking without widening what masking protects.
 *
 * @example
 * ```typescript
 * import { withHttpStatusHint } from '@setu-ts/common';
 *
 * throw withHttpStatusHint(
 *   new Error(`Adapter 'x' cannot order by 'status': ${internalDiagnostic}`),
 *   {
 *     status: 501,
 *     title: 'Not Implemented',
 *     detail: "Query feature 'orderBy' is not supported by the 'x' adapter.",
 *   },
 * );
 * ```
 *
 * @since 0.4.0
 */
export interface HttpStatusHint extends ErrorResponseInit {
  /**
   * The caller-facing disclosure, served verbatim — **required** here, where
   * {@linkcode ErrorResponseInit} leaves it optional, because a hint that
   * omitted it would fall back to the `Error`'s own message.
   *
   * It must contain nothing the thrower would not put in an unauthenticated
   * response body.
   */
  readonly detail: string;
}

/**
 * Brands an error with the status it should be answered with.
 *
 * The error is branded in place and returned, so identity is preserved and a
 * `throw withHttpStatusHint(new Xyz(…), hint)` reads as one statement. The
 * property is symbol-keyed and non-enumerable, so it is invisible to
 * `Object.keys`, `JSON.stringify` and spread, and the error behaves exactly as
 * it did — `instanceof`, `name`, `message` and `cause` are all untouched.
 *
 * @typeParam T - The error type, preserved in the return
 * @param error - The error to brand
 * @param hint - How it should be answered
 * @returns The same `error` reference, branded
 *
 * @example
 * ```typescript
 * export class UnsupportedThingError extends Error {
 *   constructor(thing: string, message: string) {
 *     super(message);
 *     withHttpStatusHint(this, {
 *       status: 501,
 *       title: 'Not Implemented',
 *       detail: `'${thing}' is not supported.`,
 *     });
 *   }
 * }
 * ```
 *
 * @since 0.4.0
 */
export function withHttpStatusHint<T extends Error>(error: T, hint: HttpStatusHint): T {
  Object.defineProperty(error, HTTP_STATUS_HINT, {
    value: hint,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return error;
}

/**
 * Reads the status hint an error was branded with.
 *
 * Accepts `unknown` rather than `Error` because the one caller that matters —
 * an error-handling `catch` — holds `unknown`, and a thrown non-`Error` value
 * is legal JavaScript.
 *
 * @param error - The thrown value to inspect
 * @returns The hint, or `undefined` when the value carries none
 *
 * @example
 * ```typescript
 * try {
 *   await repo.findAll(query);
 * } catch (error) {
 *   const hint = httpStatusHintOf(error);
 *   if (hint !== undefined) {
 *     // Answer hint.status with hint.detail rather than a masked 500.
 *   }
 * }
 * ```
 *
 * @since 0.4.0
 */
export function httpStatusHintOf(error: unknown): HttpStatusHint | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const carrier = error as { readonly [HTTP_STATUS_HINT]?: unknown };
  const value = carrier[HTTP_STATUS_HINT];
  return isHttpStatusHint(value) ? value : undefined;
}

/**
 * Narrows an unknown branded value. A foreign value under the same global
 * symbol is treated as absent rather than trusted — the `securityMetadataOf`
 * precedent, and the reason `Symbol.for` is safe here: another library
 * claiming this key cannot make `errorHandler` serve an arbitrary body.
 */
function isHttpStatusHint(value: unknown): value is HttpStatusHint {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { status?: unknown; title?: unknown; detail?: unknown };
  return typeof candidate.status === 'number' &&
    typeof candidate.title === 'string' &&
    typeof candidate.detail === 'string';
}
