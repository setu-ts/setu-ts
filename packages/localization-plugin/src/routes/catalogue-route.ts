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

/** Default `Cache-Control` for a served catalogue. */
const DEFAULT_CACHE_CONTROL = 'public, max-age=3600';

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
 * @param basePath - The configured prefix
 * @returns The prefix without a trailing slash
 * @throws {TypeError} If it does not start with `/` or contains `:` or `*`
 */
export function validateBasePath(basePath: unknown): string {
  if (
    typeof basePath !== 'string' || !basePath.startsWith('/') || basePath.includes(':') ||
    basePath.includes('*')
  ) {
    throw new TypeError(
      'localization-plugin: exposeCatalogues.basePath must start with "/" and contain no ":" ' +
        'or "*".',
    );
  }
  return basePath.length > 1 && basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
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
 * @param cacheControl - The `Cache-Control` value, or the default
 */
export function registerCatalogueRoute(
  router: IRouterApi,
  basePath: string,
  store: CatalogueStore,
  cacheControl: string | undefined,
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
  const cache = cacheControl ?? DEFAULT_CACHE_CONTROL;
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
        .header('Cache-Control', cache)
        .header('Content-Language', tag)
        .json(bodies.get(tag));
    },
  };
  router.get(`${basePath === '/' ? '' : basePath}/:locale`, route);
}
