/**
 * @module
 *
 * Cookie-backed sessions and session-backed form CSRF for Setu-TS.
 *
 * Registers an `ISessionService` under `CAPABILITIES.SESSION`. The default is a
 * self-contained encrypted cookie — AES-256-GCM under an HKDF-SHA256 derived key,
 * entirely through `runtime.subtle`, so there is no npm dependency and it runs on
 * Cloudflare Workers. Setting `store` moves the payload server-side and leaves
 * only an opaque id in the cookie, which makes immediate revocation possible.
 *
 * The form-CSRF middleware here is the synchronizer-token strategy, which is a
 * different mechanism from `http-security-plugin`'s stateless Origin/Referer
 * check rather than the same feature configured differently. A
 * progressive-enhancement `<Form>` post cannot set a custom header, so it can
 * satisfy this and not that; running both together is intended.
 *
 * @example
 * ```typescript
 * import { createApplication } from '@setu-ts/kernel';
 * import { RuntimePlugin } from '@setu-ts/runtime';
 * import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
 *
 * const app = createApplication({
 *   plugins: [RuntimePlugin(), SessionPlugin({ secret: mySecret, csrf: {} })],
 * });
 *
 * app.router.get('/me', (ctx) => {
 *   const session = getSession(ctx);
 *   return ctx.response.json({ userId: session.get<string>('userId') ?? null });
 * });
 * ```
 */

// Plugin
export { SessionPlugin } from './plugin/session-plugin.ts';

// Service and access
export { SessionService } from './services/session-service.ts';
export type { SessionServiceDeps } from './services/session-service.ts';
export { getSession } from './services/get-session.ts';

// CSRF
export { csrfFormMiddleware } from './middleware/csrf-form-middleware.ts';
export { CSRF_SESSION_KEY, getCsrfToken } from './csrf/token.ts';
export { verifyCsrfToken } from './csrf/verify.ts';

// Session middleware (exported for standalone wiring, e.g. `autoStart: false` test apps)
export { sessionMiddleware } from './middleware/session-middleware.ts';

// Stores
export { MemorySessionStore } from './stores/memory-session-store.ts';
export type { MemorySessionStoreDeps } from './stores/memory-session-store.ts';
export { CacheSessionStore } from './stores/cache-session-store.ts';
export type { CacheSessionStoreOptions } from './stores/cache-session-store.ts';

// Errors
export {
  CsrfTokenMismatchError,
  SessionMiddlewareMissingError,
  SessionSecretMissingError,
  SessionTooLargeError,
} from './errors.ts';

// Options
export type { CsrfFormOptions, SessionCookieOptions, SessionPluginOptions } from './options.ts';
export type { SessionMode } from './codec/crypto.ts';
