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
import type { CsrfFormOptions } from '../options.ts';
import { resolveCsrfConfig } from '../options.ts';
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
 * The `ctx.state` key under which {@linkcode csrfFormMiddleware} publishes its
 * already-resolved form-CSRF configuration.
 *
 * The middleware resolves the plugin's `csrf` block ONCE at registration, and
 * this key is how {@linkcode csrfTokenField} reads that resolution instead of
 * re-deriving the field name from its own argument — which is how the helper
 * came to render `'_csrf'` on a form the same plugin verified under a
 * configured `fieldName`, 403-ing every post (X47-2). Written before the
 * middleware's `ignoreMethods`/`exclude` short-circuits, because the GET that
 * renders the form is itself an ignored method. Read it only through
 * {@linkcode csrfTokenField}; the value's type is an internal
 * `ResolvedCsrfConfig`.
 *
 * Keyed per the M71 state-key convention (`<owner-package>:<kebab-key>`).
 *
 * @since 0.6.1
 */
export const CSRF_CONFIG_STATE_KEY = 'session-plugin:csrf-config';

/**
 * Renders this session's CSRF token as a hidden HTML form field.
 *
 * The returned markup uses the same mint-once token path as
 * {@linkcode getCsrfToken}. Its field name follows the plugin's configured
 * `csrf.fieldName`: {@linkcode csrfFormMiddleware} publishes its resolved
 * configuration under {@linkcode CSRF_CONFIG_STATE_KEY}, and this helper reads
 * it, so a form rendered by this helper names the field the verifier reads. An
 * explicit `options.fieldName` wins as an override (for a standalone
 * `csrfFormMiddleware` on a different name, or a custom renderer); with no
 * published config and no argument — a request the middleware never saw, such
 * as a React Router action — the shared `'_csrf'` default applies. In an
 * escaping Hono template, wrap the returned trusted markup with that template
 * runtime's `raw()` helper.
 *
 * @param ctx - The request context
 * @param options - An explicit field-name override; omitted reads the
 *   published form-CSRF configuration, then the shared default
 * @returns A hidden input containing the session's CSRF token
 * @throws {Error} If `SessionPlugin` or `RuntimePlugin` is not registered
 * @throws {SessionMiddlewareMissingError} If the session middleware did not run
 * @example
 * ```typescript
 * app.router.get('/login', (ctx) => {
 *   return ctx.response.html(
 *     `<form method="post">${csrfTokenField(ctx)}<button>Sign in</button></form>`,
 *   );
 * });
 * ```
 * @since 0.5.0
 */
export function csrfTokenField(
  ctx: IRequestContext,
  options: Pick<CsrfFormOptions, 'fieldName'> = {},
): string {
  // Precedence (M95c §3.1/§3.3): an explicit argument wins, then the config
  // the middleware published on THIS request, then the shared default. The
  // default comes from `resolveCsrfConfig` so it has one home; the read is one
  // `Map.get` on the render path, and the verifier is untouched — it keeps its
  // registration-time resolution.
  const published: unknown = ctx.state.get(CSRF_CONFIG_STATE_KEY);
  const publishedFieldName =
    typeof published === 'object' && published !== null && 'fieldName' in published &&
      typeof published.fieldName === 'string'
      ? published.fieldName
      : undefined;
  const fieldName = options.fieldName ?? publishedFieldName ?? resolveCsrfConfig().fieldName;
  const token = escapeHtmlAttribute(getCsrfToken(ctx));
  return `<input type="hidden" name="${escapeHtmlAttribute(fieldName)}" value="${token}">`;
}

/** Escapes the delimiter characters meaningful in a quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
