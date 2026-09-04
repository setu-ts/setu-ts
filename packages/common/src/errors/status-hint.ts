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
 * The lowest {@linkcode HttpStatusHint.status} treated as conforming.
 *
 * A hint says how an ERROR should be answered, so a `2xx` or `3xx` is rejected
 * rather than served: an error is never a success or a redirect.
 *
 * @since 0.4.0
 */
const MIN_HINT_STATUS = 400;

/**
 * The highest {@linkcode HttpStatusHint.status} treated as conforming — the
 * top of the range the web `Response` constructor accepts.
 *
 * @since 0.4.0
 */
const MAX_HINT_STATUS = 599;

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
   * The HTTP status to answer with. **Must be an integer in `400`–`599`**; a
   * hint outside that range is treated as ABSENT and the error takes the
   * ordinary masked-`500` path, because a hint says how an ERROR should be
   * answered and a status the platform cannot serve would make the error
   * handler itself throw.
   */
  readonly status: number;
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
 * @throws {TypeError} If `error` is frozen, sealed, or otherwise not
 * extensible — the brand is defined as a property on the error itself
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
  // Every read of the carrier and of the brand happens inside this `try`, and
  // each member is read EXACTLY ONCE into a local. Two reasons, both of which
  // the documented "a foreign value is treated as absent rather than trusted"
  // promise depends on:
  //
  //   1. The key is `Symbol.for`, so any package can define it — including as
  //      a throwing getter. Left unguarded that throw escapes `errorHandler`'s
  //      catch, which is the one `catch` in the framework whose job is to
  //      contain throws, so the error path would itself become the fault.
  //   2. A STATEFUL getter could otherwise pass validation and then return
  //      something else when the response is built. Returning a frozen
  //      snapshot removes that by construction rather than by luck: the
  //      previous version happened to read `status` four times, so a value
  //      that changed on the second read was caught by accident — a getter
  //      that changed on the fifth would not have been.
  try {
    const carrier = error as { readonly [HTTP_STATUS_HINT]?: unknown };
    const value = carrier[HTTP_STATUS_HINT];
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as {
      status?: unknown;
      title?: unknown;
      detail?: unknown;
      details?: unknown;
    };
    const status = candidate.status;
    const title = candidate.title;
    const detail = candidate.detail;
    const details = candidate.details;
    if (!isConformingStatus(status)) return undefined;
    if (typeof title !== 'string' || typeof detail !== 'string') return undefined;
    // `details` is optional on `ErrorResponseInit`. A non-plain-object value
    // is dropped rather than rejecting the whole hint: the three required
    // members are what the response is built from, and `details` is an
    // extension bag no in-repo brand sets.
    const carriedDetails =
      typeof details === 'object' && details !== null && !Array.isArray(details)
        ? (details as Readonly<Record<string, unknown>>)
        : undefined;
    return Object.freeze(
      carriedDetails === undefined
        ? { status, title, detail }
        : { status, title, detail, details: carriedDetails },
    );
  } catch {
    // A hostile or buggy accessor reads as ABSENT, exactly like a malformed
    // brand: the error then takes the ordinary masked path.
    return undefined;
  }
}

/**
 * Reports whether a brand's `status` is one this framework will serve.
 *
 * Checked against {@linkcode MIN_HINT_STATUS}–{@linkcode MAX_HINT_STATUS}, not
 * merely against `typeof === 'number'`, for two reasons.
 *
 * The first is that a status outside the web `Response` constructor's
 * `[200, 599]` makes it throw `RangeError` — so a hint carrying `999`, `0`, a
 * negative, a fraction, `NaN` or `Infinity` would turn the error handler
 * itself into the fault, a throw escaping the one `catch` that exists to
 * contain throws. Because `status` is typed `number` and the key is global,
 * that value arrives from another package and may be anything a `number`
 * holds; a mis-derived one collapses to `NaN` rather than to a plausible
 * status.
 *
 * The second is semantic, and it is why the floor is `400` rather than `200`:
 * a hint says how an ERROR should be answered, and an error is never a success
 * or a redirect. This is deliberately stricter than the
 * {@linkcode ErrorResponseInit} it extends — `respondWithError` takes its
 * status from a literal at the call site, visible in review, while a brand
 * travels from another package inside an error.
 */
function isConformingStatus(status: unknown): status is number {
  if (typeof status !== 'number') return false;
  // `Number.isInteger` runs FIRST and is load-bearing: `NaN` makes `<` and `>`
  // both false, so a bare range check would ACCEPT it — and `NaN` is what a
  // mis-derived status collapses to. Measured, not assumed.
  if (!Number.isInteger(status)) return false;
  return status >= MIN_HINT_STATUS && status <= MAX_HINT_STATUS;
}
