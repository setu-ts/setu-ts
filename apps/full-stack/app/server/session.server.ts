import type { ISession } from '@setu-ts/common';

import type { AppLoadContext } from '~/lib/load-context.ts';
import {
  csrfContext,
  type CurrentUser,
  currentUserContext,
  sessionContext,
} from '~/server/context-keys.server.ts';

/**
 * Typed access to the request values that are not services.
 *
 * @param value - The value read from the request context
 * @param name - The value's name, for the error message
 * @returns The value, once known to be present
 * @throws {Error} If the value is absent: its key is not set in
 * populateLoadContext, or this ran outside a loader or action
 */
export function requireValue<T>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(
      `No ${name} on this request. Set its context key in populateLoadContext in ` +
        'setu.config.ts, and call this only from a loader or action.',
    );
  }
  return value;
}

/** Resolves the session for the current request. */
export function getSession(context: AppLoadContext): ISession {
  return requireValue(context.get(sessionContext), 'session');
}

/**
 * Resolves the CSRF token to embed in a form.
 *
 * Read through this accessor rather than the key directly, so route components
 * — which ship to the browser — never import a server-only module.
 */
export function getCsrfToken(context: AppLoadContext): string {
  return requireValue(context.get(csrfContext), 'CSRF token');
}

/**
 * Resolves the signed-in user the `requireUser` route middleware put on the context.
 *
 * Throws on a route that middleware does not guard. That is deliberate: a loader
 * that needs a user should be unreachable without one.
 */
export function getCurrentUser(context: AppLoadContext): CurrentUser {
  const user = context.get(currentUserContext);
  if (user === null) {
    throw new Error(
      'No signed-in user on this request. Guard the route with ' +
        '`export const middleware = [requireUser];` from ~/server/require-user.server.ts.',
    );
  }
  return user;
}
