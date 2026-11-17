import { contextKeyFor } from '@setu-ts/react-router-plugin';
import type { ISession } from '@setu-ts/common';

/**
 * Context keys for the values a page reads that are NOT services: the session,
 * the CSRF token and the signed-in user. Services — a module's, or a
 * capability such as the logger — come through `getService(context, TOKEN)`.
 *
 * Two things make these keys work, and both are easy to break:
 *
 * 1. **Keys come from `contextKeyFor`, never from a `{ defaultValue }`
 *    literal.** Vite INLINES application modules into the server build, while
 *    the runtime loads `setu.config.ts` from source — so this module exists
 *    twice, and two hand-written key objects would look identical and match
 *    nothing. Resolving each key by NAME through the plugin gives both copies
 *    the same object.
 * 2. **This module is `.server.ts`.** It imports a framework package by value,
 *    which only the server build may do.
 */

/** The signed-in user, as a page sees it. Plain data. */
export interface CurrentUser {
  /** The address the user signed in with. */
  readonly email: string;
}

/** The kernel request id, for correlating SSR failures with request logs. */
export const requestIdContext = contextKeyFor<string | null>('app.request-id', null);

/** The session for the current request; set in `setu.config.ts`. */
export const sessionContext = contextKeyFor<ISession | null>('app.session', null);

/**
 * The CSRF token for the current request, for embedding in a form; set in
 * `setu.config.ts`. The check itself lives in the session plugin's middleware.
 */
export const csrfContext = contextKeyFor<string | null>('app.csrf', null);

/**
 * The signed-in user, on the routes `requireUser` guards. Set by that route
 * middleware (`app/server/require-user.server.ts`), not by `setu.config.ts`;
 * `null` everywhere else.
 */
export const currentUserContext = contextKeyFor<CurrentUser | null>('app.current-user', null);
