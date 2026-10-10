/**
 * Shared authorization-refusal responses.
 *
 * @module
 */

import { respondWithError } from './error-responder.ts';
import type { ErrorResponderTarget } from './error-responder.ts';
import type { HttpStatusHint } from './status-hint.ts';

/**
 * The authorization condition that determines a standard refusal response.
 *
 * @since 0.5.0
 */
export type AuthorizationFailure =
  | 'authentication-required'
  | 'not-configured'
  | 'insufficient-privileges'
  | 'second-factor-required';

/**
 * The status, title and caller-facing detail of each standard refusal.
 *
 * Frozen and module-private: {@linkcode authorizationFailureInit} hands out
 * these values, and a caller that mutated one would change every later
 * refusal in the process.
 */
const FAILURE_INITS: Readonly<Record<AuthorizationFailure, HttpStatusHint>> = Object.freeze({
  'authentication-required': Object.freeze({
    status: 401,
    title: 'Unauthorized',
    detail: 'Authentication required',
  }),
  'not-configured': Object.freeze({
    status: 501,
    title: 'Not Implemented',
    detail: 'Authorization is not configured',
  }),
  'insufficient-privileges': Object.freeze({
    status: 403,
    title: 'Forbidden',
    detail: 'Insufficient privileges',
  }),
  'second-factor-required': Object.freeze({
    status: 403,
    title: 'Forbidden',
    detail: 'Second factor required',
  }),
});

/**
 * Returns the status, title and detail of a standard authorization refusal —
 * the ONE owner of those values.
 *
 * {@linkcode respondWithAuthorizationFailure} writes it, and an error thrown
 * from a handler brands itself with it (through `withHttpStatusHint`), so a
 * guard's refusal and a thrown refusal answer the same body under the
 * application's configured error format.
 *
 * The `insufficient-privileges` detail is deliberately fixed text: naming the
 * role, permission or policy a caller lacks tells an unauthorized caller what
 * to acquire. The `second-factor-required` detail says only what the caller
 * must do, not which factor or which policy produced the refusal.
 *
 * @param failure - Which refusal
 * @returns The frozen response init for that refusal
 * @example
 * ```typescript
 * throw withHttpStatusHint(new Error('denied'), authorizationFailureInit('insufficient-privileges'));
 * ```
 * @since 0.9.0
 */
export function authorizationFailureInit(failure: AuthorizationFailure): HttpStatusHint {
  return FAILURE_INITS[failure];
}

/**
 * Write the framework-standard response for an authorization refusal.
 *
 * This keeps guards and decorator middleware byte-identical without coupling
 * either plugin to the other's implementation. Every arm writes through
 * {@linkcode respondWithError}, so the refusal answers in whatever error format
 * the application configured rather than a shape of this function's own. The
 * values come from {@linkcode authorizationFailureInit}.
 *
 * @param target - The request context or response to write the refusal to
 * @param failure - Which refusal to write
 * @since 0.5.0
 */
export function respondWithAuthorizationFailure(
  target: ErrorResponderTarget,
  failure: AuthorizationFailure,
): void {
  respondWithError(target, authorizationFailureInit(failure));
}
