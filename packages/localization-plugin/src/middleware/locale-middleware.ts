/**
 * The locale resolution middleware.
 *
 * Resolves the request's locale from the query parameter, the cookie,
 * `Accept-Language`, a tenant default, then the default locale — matching
 * every candidate against the supported set only — and writes it to
 * `ctx.request.locale`. It appends `Vary` before the handler runs and writes
 * `Content-Language` after it returns.
 *
 * @module
 * @since 0.9.0
 */
import type {
  IRequestContext,
  MiddlewareFunction,
  NextFunction,
  PathPattern,
} from '@setu-ts/common';
import { createPathMatcher, parseCookie, replaceLocale } from '@setu-ts/common';

import { validateSupportedLocales } from '../catalogue/validate.ts';
import { negotiateLocale, parseAcceptLanguage } from '../format/negotiate.ts';
import type { LocaleMiddlewareOptions } from '../interfaces/index.ts';

/**
 * The operational paths skipped by default: a probe carries no language
 * preference, so resolving one is wasted work. The same six the tenancy
 * middleware skips.
 */
export const DEFAULT_EXCLUDED_PATHS: readonly PathPattern[] = Object.freeze([
  '/live',
  '/ready',
  '/health',
  '/metrics',
  '/openapi.json',
  '/docs',
]);

/** Default query parameter name. */
const DEFAULT_QUERY = 'locale';

/** Default cookie name. */
const DEFAULT_COOKIE = 'setu_locale';

/**
 * Creates the locale resolution middleware.
 *
 * Register it globally (the plugin does, at priority 45) or per route group
 * when the plugin's own registration is disabled. On every path it does not
 * exclude it:
 *
 * 1. appends `Vary: Accept-Language` — plus `Cookie` while the cookie source is
 *    enabled — before `next()`, unconditionally, because the response varies
 *    by those headers whether or not they won this time;
 * 2. writes the resolved tag through `replaceLocale`;
 * 3. after `next()` resolves, sets `Content-Language` from the FINAL
 *    `ctx.request.locale`, unless the response already carries one or the
 *    final value is not a supported tag. A rejection from `next()` propagates
 *    with no `Content-Language` written.
 *
 * @param options - The supported locales and the resolution sources
 * @returns The middleware
 * @throws {TypeError | RangeError} If `supportedLocales` is invalid
 * @example
 * ```typescript
 * app.middleware.add(localeMiddleware({ supportedLocales: ['en', 'de'] }), { priority: 45 });
 * ```
 * @since 0.9.0
 */
export function localeMiddleware(options: LocaleMiddlewareOptions): MiddlewareFunction {
  const supported = validateSupportedLocales(options.supportedLocales);
  const supportedSet: ReadonlySet<string> = new Set(supported);
  const defaultTag = supported[0];
  const queryName = options.query === undefined ? DEFAULT_QUERY : options.query;
  const cookieName = options.cookie === undefined ? DEFAULT_COOKIE : options.cookie;
  const tenantLocale = options.tenantLocale;
  const isExcluded = createPathMatcher(options.exclude ?? DEFAULT_EXCLUDED_PATHS);
  const vary = cookieName === false ? 'Accept-Language' : 'Accept-Language, Cookie';

  const resolve = (ctx: IRequestContext): string => {
    if (queryName !== false) {
      const value = ctx.query[queryName];
      const matched = value === undefined ? undefined : negotiateLocale([value], supported);
      if (matched !== undefined) {
        return matched;
      }
    }
    if (cookieName !== false) {
      const value = parseCookie(ctx.request.headers.get('cookie'))[cookieName];
      const matched = value === undefined ? undefined : negotiateLocale([value], supported);
      if (matched !== undefined) {
        return matched;
      }
    }
    const header = parseAcceptLanguage(ctx.request.headers.get('accept-language'));
    const fromHeader = negotiateLocale(header.preferred, supported, header.excluded);
    if (fromHeader !== undefined) {
      return fromHeader;
    }
    const tenant = ctx.request.tenant;
    if (tenantLocale !== undefined && tenant !== undefined) {
      const value = tenantLocale(tenant);
      const matched = value === undefined ? undefined : negotiateLocale([value], supported);
      if (matched !== undefined) {
        return matched;
      }
    }
    return defaultTag;
  };

  return async (ctx: IRequestContext, next: NextFunction): Promise<void> => {
    if (isExcluded(ctx.request.path)) {
      await next();
      return;
    }
    ctx.response.appendHeader('Vary', vary);
    replaceLocale(ctx.request, resolve(ctx));
    await next();
    const final = ctx.request.locale;
    // Only a supported tag is written: an application can `replaceLocale` any
    // string, and a header value must never carry text nobody configured.
    if (
      final !== undefined && supportedSet.has(final) &&
      !ctx.response.snapshot().headers.has('content-language')
    ) {
      ctx.response.header('Content-Language', final);
    }
  };
}
