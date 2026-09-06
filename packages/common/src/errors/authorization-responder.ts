/**
 * Shared authorization-refusal responses.
 *
 * @module
 */

import { respondWithError } from './error-responder.ts';
import type { ErrorResponderTarget } from './error-responder.ts';

/** The authorization condition that determines a standard refusal response. */
export type AuthorizationFailure =
  | 'authentication-required'
  | 'not-configured'
  | 'insufficient-privileges';

/**
 * Write the framework-standard response for an authorization refusal.
 *
 * This keeps guards and decorator middleware byte-identical without coupling
 * either plugin to the other's implementation.
 */
export function respondWithAuthorizationFailure(
  target: ErrorResponderTarget,
  failure: AuthorizationFailure,
): void {
  switch (failure) {
    case 'authentication-required':
      respondWithError(target, {
        status: 401,
        title: 'Unauthorized',
        detail: 'Authentication required',
      });
      return;
    case 'not-configured':
      respondWithError(target, {
        status: 501,
        title: 'Not Implemented',
        detail: 'Authorization is not configured',
      });
      return;
    case 'insufficient-privileges':
      respondWithError(target, {
        status: 403,
        title: 'Forbidden',
        detail: 'Insufficient privileges',
      });
      return;
  }
}
