/**
 * @module
 *
 * Localization plugin — message catalogues per locale, request locale
 * resolution, and a formatter shared with the browser.
 *
 * `LocalizationPlugin` registers an `ILocalizer` under
 * `CAPABILITIES.LOCALIZATION`, validates every catalogue at `register()`, and
 * resolves each request's locale (query, cookie, `Accept-Language`, a tenant
 * default, then the default) into `ctx.request.locale`. `localizerFor(ctx)`
 * returns the localizer for that locale. The formatter and locale negotiation
 * also ship as the import-free subpath `@setu-ts/localization-plugin/format`,
 * so a browser formats with the same code the server used.
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */
import { MissingMessageError, UnsupportedLocaleError } from './errors.ts';
import { MissingPluralCountError } from './format/format.ts';
import type {
  IMessageSource,
  LocaleMiddlewareOptions,
  LocalizationPluginOptions,
} from './interfaces/index.ts';
import { localeMiddleware } from './middleware/locale-middleware.ts';
import { LocalizationPlugin } from './plugin/localization-plugin.ts';
import { localizerFor } from './service/localizer.ts';

export { MissingMessageError, MissingPluralCountError, UnsupportedLocaleError };
export { localeMiddleware };
export { LocalizationPlugin };
export { localizerFor };
export type { IMessageSource, LocaleMiddlewareOptions, LocalizationPluginOptions };
