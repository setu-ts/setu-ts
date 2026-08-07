/**
 * The session-backed CSRF token.
 *
 * The token is 32 random bytes stored in the session under a reserved key. It
 * needs no signature and no second cookie of its own: the session it lives in is
 * already encrypted or signed, so a client cannot forge or read it. That is why
 * this ships beside sessions rather than as an option on the stateless
 * Origin/Referer middleware in `http-security-plugin`.
 *
 * It also means the token's lifetime is the session's lifetime, so it cannot
 * expire out from under a form that is still on screen inside a live session.
 *
 * @module
 */
import type { IRequestContext, IRuntimeServices, ISession } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { toBase64Url } from '../codec/envelope.ts';
import { getSession } from '../services/get-session.ts';

/**
 * Reserved session key holding the CSRF token.
 *
 * Namespaced so it cannot collide with application data, and exported so an
 * application clearing selected keys knows to leave it alone.
 *
 * @since 0.2.0
 */
export const CSRF_SESSION_KEY = '__csrf';

/** Token length in bytes; 256 bits of entropy. */
const TOKEN_BYTES = 32;

/**
 * Returns this session's CSRF token, minting and storing one on first call.
 *
 * Call it from whatever renders the form, and put the result in a hidden field
 * named to match the configured `fieldName` (default `_csrf`). Minting marks the
 * session dirty, so the token is committed with the response that carries the
 * form.
 *
 * @param ctx - The request context
 * @returns The token to embed in the form
 * @throws {Error} If `SessionPlugin` or `RuntimePlugin` is not registered
 * @throws {SessionMiddlewareMissingError} If the session middleware did not run
 * @example
 * ```typescript
 * app.router.get('/login', (ctx) => {
 *   const token = getCsrfToken(ctx);
 *   return ctx.response.text(
 *     `<form method="post"><input type="hidden" name="_csrf" value="${token}"></form>`,
 *   );
 * });
 * ```
 * @since 0.2.0
 */
export function getCsrfToken(ctx: IRequestContext): string {
  const session = getSession(ctx);

  const existing = readCsrfToken(session);
  if (existing !== undefined) {
    return existing;
  }

  // Randomness comes from the runtime capability rather than global `crypto`,
  // and is resolved under its own documented token rather than reached through
  // the session service, so each token keeps its documented interface.
  const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  const token = toBase64Url(runtime.randomBytes(TOKEN_BYTES));
  session.set(CSRF_SESSION_KEY, token);
  return token;
}

/**
 * Reads the stored token without minting one.
 *
 * @param session - The session to read
 * @returns The token, or `undefined` when this session has none yet
 * @since 0.2.0
 */
export function readCsrfToken(session: ISession): string | undefined {
  const token = session.get<unknown>(CSRF_SESSION_KEY);
  return typeof token === 'string' && token !== '' ? token : undefined;
}
