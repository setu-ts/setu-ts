/**
 * The opt-in catalogue route — one supported locale's messages as JSON, for a
 * browser that formats after hydration.
 *
 * @module
 * @since 0.9.0
 */
import type { IRouterApi, LocalizationMessage, RouteDefinition } from '@setu-ts/common';
import { respondWithError } from '@setu-ts/common';

import type { CatalogueStore } from '../catalogue/validate.ts';

/**
 * Default `Cache-Control` for a served catalogue: browser-cacheable, never
 * shared. A session configured with `rolling` or `idleTimeoutMs` re-issues its
 * cookie on every response, this one included, and a shared cache storing a
 * `Set-Cookie` response would hand that session to other users. An
 * application that knows the route carries no cookie opts into edge caching
 * with `cacheControl: 'public, max-age=3600'`.
 */
const DEFAULT_CACHE_CONTROL = 'private, max-age=3600';

/** Where the route middleware hands the matched tag to the handler. */
const LOCALE_STATE_KEY = 'localization-plugin:catalogue-locale';

/** The JSON body served for one locale. */
interface CatalogueBody {
  readonly locale: string;
  readonly messages: Readonly<Record<string, LocalizationMessage>>;
}

/**
 * Validates `exposeCatalogues.basePath` at construction.
 *
 * A path segment is letters, digits, `.`, `_`, `~` or `-`, so `:`, `*`, `?`,
 * `#`, `//` and control characters — each of which would register a pattern,
 * a dead route, or nothing at all — are refused. The root (`/`) is refused
 * too: it would register `/:locale`, claiming every unrouted single-segment
 * `GET` in the application.
 *
 * @param basePath - The configured prefix
 * @returns The prefix without a trailing slash
 * @throws {TypeError} If it is not one or more plain path segments
 */
export function validateBasePath(basePath: unknown): string {
  if (typeof basePath !== 'string' || !BASE_PATH.test(basePath)) {
    throw new TypeError(
      'localization-plugin: exposeCatalogues.basePath must be one or more path segments ' +
        '(letters, digits, ".", "_", "~", "-"), such as "/i18n" — not the root.',
    );
  }
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

/** One or more plain segments, an optional trailing slash, never the root. */
const BASE_PATH = /^(?:\/[A-Za-z0-9._~-]+)+\/?$/;

/**
 * Validates `exposeCatalogues.cacheControl` at construction.
 *
 * The value becomes a response header on every catalogue request, and
 * `Headers.set` throws for a value carrying a control character — so an
 * unvalidated value would answer `500` on every request to the route. The
 * check probes the platform's own `Headers` rather than restating its rules,
 * and quotes its message (the M97b `@ResponseHeader` precedent).
 *
 * @param cacheControl - The configured value, or `undefined` for the default
 * @returns The value to send
 * @throws {TypeError} If the value is not a string the platform accepts as a header value
 */
export function validateCacheControl(cacheControl: unknown): string {
  if (cacheControl === undefined) {
    return DEFAULT_CACHE_CONTROL;
  }
  try {
    if (typeof cacheControl !== 'string') {
      throw new TypeError('not a string');
    }
    new Headers().set('cache-control', cacheControl);
    return cacheControl;
  } catch (error) {
    throw new TypeError(
      `localization-plugin: exposeCatalogues.cacheControl is not a valid header value (${
        (error as Error).message
      }).`,
    );
  }
}

/**
 * Registers `GET <basePath>/:locale`.
 *
 * A supported tag (exact canonical spelling) answers `{ locale, messages }`
 * with `Cache-Control` and `Content-Language`. Anything else answers `404`
 * through the error responder with a FIXED detail: the parameter is never
 * looked up beyond the supported set and never echoed. The refusal runs as
 * route middleware because `respondWithError` writes the response without the
 * `HandlerResult` a handler must return (the M100c sign-in precedent).
 *
 * @param router - The plugin's router
 * @param basePath - The validated prefix
 * @param store - The validated catalogues
 * @param cacheControl - The validated `Cache-Control` value
 */
export function registerCatalogueRoute(
  router: IRouterApi,
  basePath: string,
  store: CatalogueStore,
  cacheControl: string,
): void {
  // Built once: the catalogues are fixed after `register()`.
  const bodies = new Map<string, CatalogueBody>();
  // Validation leaves one message map per supported tag (an empty one for a
  // partial locale), so every supported tag gets a body. Each body is the
  // default locale's messages overlaid with the tag's own, so a browser served
  // a partial locale sees the same fallback `t()` applies on the server.
  // `validateCatalogues` refuses a default locale with no catalogue.
  const defaults = store.messages.get(store.supported[0]) as ReadonlyMap<
    string,
    LocalizationMessage
  >;
  for (const [tag, messages] of store.messages) {
    const merged = Object.fromEntries([...defaults, ...messages]);
    bodies.set(tag, Object.freeze({ locale: tag, messages: merged }));
  }
  const route: RouteDefinition = {
    middleware: [async (ctx, next) => {
      const tag = ctx.params.locale;
      if (!bodies.has(tag)) {
        respondWithError(ctx, { status: 404, title: 'Not Found', detail: 'Unknown locale' });
        return;
      }
      ctx.state.set(LOCALE_STATE_KEY, tag);
      await next();
    }],
    handler: (ctx) => {
      const tag = ctx.state.get(LOCALE_STATE_KEY) as string;
      return ctx.response
        .header('Cache-Control', cacheControl)
        .header('Content-Language', tag)
        .json(bodies.get(tag));
    },
  };
  router.get(`${basePath}/:locale`, route);
}
