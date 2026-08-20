/**
 * The request-scoped error responder seam.
 *
 * A package that produces an error response but may not import
 * `@setu-ts/exceptions` (AI_GUIDELINES §2.2) — where every formatter lives —
 * answers in the application's configured format by delegating to a responder
 * published into `ctx.state` under {@linkcode ERROR_RESPONDER_STATE_KEY}.
 *
 * `@setu-ts/exceptions`' `errorHandler` publishes the responder (built from the
 * formatter and content type it already resolved at factory time) before
 * `await next()`. When no responder is present — no `errorHandler` registered,
 * or a site running before it — {@linkcode respondWithError} writes the
 * framework-default `{ error: title, detail? }` body, which is today's shape
 * family, so an application without `errorHandler` is byte-identical to today.
 *
 * The status is always written by the calling site through this function, so
 * pipeline semantics, metrics, telemetry and the access log keep seeing the
 * status the client sees — the alternative (throwing and letting `errorHandler`
 * format) would move every unmatched route to `status="500"` in metrics, where
 * the HTTP collector hardcodes the status on its catch path.
 *
 * @module
 */
import type { IResponse } from '../http.ts';

/**
 * The `ctx.state` key under which an application's resolved error responder is
 * published.
 *
 * `IRequestContext.state` is a `Map<string, unknown>` — string keys only — so
 * the seam is a string constant rather than a `Symbol.for` brand. Exported so a
 * third-party error handler can publish a responder too.
 *
 * @since 0.1.0
 */
export const ERROR_RESPONDER_STATE_KEY = 'setu.error.responder';

/**
 * The minimal context an error responder needs to write a response: the
 * request-scoped state (where the responder itself is published), the response
 * builder to write to, and the request (for the Problem Details `instance`).
 *
 * `IRequestContext` is structurally assignable to this, so middleware passes its
 * full context while the kernel's two pre-pipeline sites — the shutdown drain
 * and the malformed-URL `400`, which run before a context exists — pass a bare
 * object. A bare object carries an empty state, so it always takes the fallback
 * shape, which is exactly right for a site that runs before `errorHandler`.
 *
 * @since 0.1.0
 */
export interface ErrorResponderTarget {
  /** Request-scoped state; the responder is published under {@linkcode ERROR_RESPONDER_STATE_KEY}. */
  readonly state: Map<string, unknown>;
  /** The response builder to write the error response to. */
  readonly response: IResponse;
  /** The request, when one exists (supplies the Problem Details `instance`). */
  readonly request?: { readonly path: string };
}

/**
 * The initialization of an error response produced through the responder seam.
 *
 * @since 0.1.0
 */
export interface ErrorResponseInit {
  /** The HTTP status code to answer with. */
  readonly status: number;
  /**
   * The framework-default `error` member. In a formatted response this is the
   * Problem Details `detail` when no `detail` is supplied.
   */
  readonly title: string;
  /** An optional disclosure, kept verbatim by every format. */
  readonly detail?: string;
  /** Optional structured details (e.g. a validation `errors` array). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * A request-scoped error responder: writes an error response in the
 * application's configured format.
 *
 * Implemented by `@setu-ts/exceptions` from the formatter and content type its
 * `errorHandler` resolved at factory time. The interface — not a formatter
 * reference — is what `common` carries, because a package without `exceptions`
 * cannot construct the `HttpError` a formatter needs: a plain `Error` carries
 * no `statusCode`, so a formatter would answer `500` for a tenant `400` and
 * `maskInternalErrors` would then mask it.
 *
 * @since 0.1.0
 */
export interface IErrorResponder {
  /**
   * Writes an error response in the configured format.
   *
   * @param target - The context (state, response, request) to write into
   * @param init - The error to respond with
   */
  respond(target: ErrorResponderTarget, init: ErrorResponseInit): void;
}

/**
 * Responds to an error in the application's configured format.
 *
 * Reads the responder published under {@linkcode ERROR_RESPONDER_STATE_KEY} and
 * delegates to it. When no conforming responder is present — no `errorHandler`
 * registered, or a site running before it — writes the framework-default
 * `{ error: title }` body (plus `detail` when the init carries one) as
 * `application/json`, byte-identical to the shape the framework wrote before
 * this seam existed.
 *
 * A state value that is not a conforming responder is ignored (the fallback is
 * written) rather than thrown through, so a misconfigured or third-party state
 * value can never turn an error response into a `500`.
 *
 * @param target - The context (state, response, request) to write into
 * @param init - The error to respond with
 * @since 0.1.0
 */
export function respondWithError(target: ErrorResponderTarget, init: ErrorResponseInit): void {
  const responder = target.state.get(ERROR_RESPONDER_STATE_KEY);
  if (isErrorResponder(responder)) {
    responder.respond(target, init);
    return;
  }
  // The no-responder fallback writes through `.json()` — the SAME call the
  // framework's sites made before this seam existed — so the body AND the
  // content-type header are byte-identical to today. (The responder, by
  // contrast, must use `.send(bytes)` so its `application/problem+json`
  // content type is not overwritten by `.json()`'s own default.)
  //
  // The two calls are separate statements rather than chained: `status()`
  // returns `IResponse` on the real builder but `void` on many test fakes, so
  // chaining would crash a minimal context that only needs to record the status.
  const body: Record<string, unknown> = { error: init.title };
  if (init.detail !== undefined) {
    body.detail = init.detail;
  }
  target.response.status(init.status);
  target.response.json(body);
}

/** Narrows an unknown `ctx.state` value to a conforming {@linkcode IErrorResponder}. */
function isErrorResponder(value: unknown): value is IErrorResponder {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IErrorResponder).respond === 'function'
  );
}
