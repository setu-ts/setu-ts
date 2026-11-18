import { type MiddlewareFunction, redirect } from 'react-router';

import { currentUserContext, sessionContext } from '~/server/context-keys.server.ts';

/**
 * React Router route middleware: only a signed-in user gets past it.
 *
 * This project has two middleware layers, and this is the second one:
 *
 * - **Kernel middleware** (`npx @setu-ts/cli@0.13.0 generate middleware <name>`,
 *   in `src/middleware/`)
 *   runs for EVERY request the application serves — health probes, API routes,
 *   static files and SSR pages alike — and works on the kernel request context.
 *   Use it for cross-cutting concerns: headers, auditing, rate limits.
 * - **Route middleware** (this module) runs only for the SSR routes it is attached
 *   to, for both the document request and the client-side navigation's data
 *   request. It reads and writes React Router's context, so it can read the
 *   session and hand a loader a value. Use it for page-level rules.
 *
 * Attach it by exporting a `middleware` array from a route module:
 *
 * ```ts
 * export const middleware = [requireUser];
 * ```
 *
 * Exported from a LAYOUT module (`app/components/layouts/AppLayout.tsx`) it guards
 * every route in that group. This scaffold attaches it page by page: each guarded
 * page exports `middleware = [requireUser]`.
 *
 * The `.server.ts` suffix is safe here: React Router strips the `middleware`
 * export — and the imports only it uses — from the browser bundle.
 *
 * A refusal from this layer is rendered by React Router's route error boundary,
 * not by the kernel error responder. Throw `redirect()` for anonymous document
 * requests or `data(..., { status: 403 })` for a forbidden page; API callers
 * that require Problem Details should call a kernel API route.
 */
export const requireUser: MiddlewareFunction<Response> = ({ context }, next) => {
  const email = context.get(sessionContext)?.get<string>('userEmail');
  if (email === undefined || email === '') {
    // A thrown redirect ends the chain: no loader and no later middleware runs.
    throw redirect('/login');
  }
  // Loaders below this middleware read it with getCurrentUser(context).
  context.set(currentUserContext, { email });
  return next();
};
