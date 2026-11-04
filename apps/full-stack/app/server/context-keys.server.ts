import { contextKeyFor } from '@setu-ts/react-router-plugin';
import type { ISession } from '@setu-ts/common';

/**
 * Context keys for session and CSRF values. Kernel services are resolved
 * through getService(context, TOKEN), without application context keys.
 *
 * `setu.config.ts` sets them; loaders and actions read them. Two things make
 * that work, and both are easy to break:
 *
 * 1. **Keys come from `contextKeyFor`, never from a `{ defaultValue }`
 *    literal.** Vite INLINES application modules into the server build, while
 *    the runtime loads `setu.config.ts` from source — so this module exists
 *    twice, and two hand-written key objects would look identical and match
 *    nothing. Resolving each key by NAME through the plugin gives both copies
 *    the same object. Nothing type-checks this: with a literal, every read
 *    silently returns the default and the page renders empty.
 * 2. **This module is `.server.ts`.** It imports framework packages by value,
 *    which only the server build may do: they are external there (see
 *    `vite.config.ts`) and resolve at runtime, whereas the client bundle would
 *    have to inline them.
 *
 * The session key is the clearest case for why the bridge lives in app code at
 * all: `getSession` needs the kernel request context, which a loader never
 * sees, while `populateLoadContext` receives exactly that — and doing it here
 * keeps the SSR plugin from importing the session plugin.
 */

/** The session for the current request. */
export const sessionContext = contextKeyFor<ISession | null>('app.session', null);

/**
 * The CSRF token for the current request, for embedding in a form.
 *
 * The synchronizer-token check lives in the session plugin's middleware; the
 * form only has to echo this value back.
 */
export const csrfContext = contextKeyFor<string | null>('app.csrf', null);
