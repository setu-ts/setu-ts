/**
 * LocalizationPlugin — registers an `ILocalizer` under
 * `CAPABILITIES.LOCALIZATION`, the locale resolution middleware at priority 45,
 * an opt-in catalogue route, and a `localization` health indicator.
 *
 * Option shapes are refused at construction; catalogues are validated at
 * `register()` (a `source` is loaded there), so a translation gap fails
 * startup rather than a request. After `register()` the plugin holds no
 * backend and nothing to release, so it declares no `onClose`.
 *
 * @module
 * @since 0.9.0
 */
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { validateCatalogues, validateSupportedLocales } from '../catalogue/validate.ts';
import type { LocalizationPluginOptions } from '../interfaces/index.ts';
import { localeMiddleware } from '../middleware/locale-middleware.ts';
import {
  registerCatalogueRoute,
  validateBasePath,
  validateCacheControl,
} from '../routes/catalogue-route.ts';
import { createLocalizer } from '../service/localizer.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'localization-plugin';

/** Default middleware priority: after tenant (40), before logging (50). */
const DEFAULT_PRIORITY = 45;

/** Refuses a `timeZone` the runtime's `Intl` cannot use, naming it. */
function validateTimeZone(timeZone: unknown): string | undefined {
  if (timeZone === undefined) {
    return undefined;
  }
  if (typeof timeZone === 'string') {
    try {
      new Intl.DateTimeFormat('en', { timeZone });
      return timeZone;
    } catch {
      // Falls through to the refusal below.
    }
  }
  throw new RangeError(
    `localization-plugin: timeZone ${JSON.stringify(timeZone)} is not an IANA time zone ` +
      "this runtime's Intl recognizes.",
  );
}

/**
 * Creates the LocalizationPlugin.
 *
 * @param options - Supported locales, catalogues (or a source), and the
 *   resolution, formatting and route settings
 * @returns The plugin instance
 * @throws {TypeError | RangeError} If an option is malformed: an empty or
 *   invalid `supportedLocales`, both or neither of `catalogues`/`source`, an
 *   unknown `timeZone`, a non-integer `middleware.priority`, or a bad
 *   `exposeCatalogues.basePath`
 * @example
 * ```typescript
 * import { createApplication } from '@setu-ts/kernel';
 * import { RuntimePlugin } from '@setu-ts/runtime';
 * import { LocalizationPlugin } from '@setu-ts/localization-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     RuntimePlugin(),
 *     LocalizationPlugin({
 *       supportedLocales: ['en', 'de'],
 *       catalogues: {
 *         en: { greeting: 'Hello {name}' },
 *         de: { greeting: 'Hallo {name}' },
 *       },
 *     }),
 *   ],
 * });
 * ```
 * @since 0.9.0
 */
export function LocalizationPlugin(options: LocalizationPluginOptions): IPlugin {
  const supported = validateSupportedLocales(options.supportedLocales);
  const hasCatalogues = options.catalogues !== undefined;
  const hasSource = options.source !== undefined;
  if (hasCatalogues === hasSource) {
    throw new TypeError(
      'localization-plugin: supply exactly one of `catalogues` (static) and `source` ' +
        '(loaded once at register()).',
    );
  }
  const timeZone = validateTimeZone(options.timeZone);
  const middleware = options.middleware ?? {};
  const priority = middleware.priority ?? DEFAULT_PRIORITY;
  if (!Number.isInteger(priority)) {
    throw new TypeError('localization-plugin: middleware.priority must be an integer.');
  }
  const basePath = options.exposeCatalogues === undefined
    ? undefined
    : validateBasePath(options.exposeCatalogues.basePath);
  const cacheControl = validateCacheControl(options.exposeCatalogues?.cacheControl);

  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    provides: [CAPABILITIES.LOCALIZATION],
    // The logger orders first so a partial-catalogue warning raised during
    // `register()` reaches it. Nothing else is resolved at registration — the
    // tenant default is read per request, which middleware PRIORITY (40 < 45)
    // orders, so no tenancy edge is declared.
    optionalDependencies: [CAPABILITIES.LOGGER],
    async register(ctx: IPluginContext): Promise<void> {
      const raw = options.source === undefined ? options.catalogues : await options.source.load();
      const store = validateCatalogues(
        supported,
        raw,
        options.allowPartialCatalogues === true,
        (message) => ctx.logger?.warn(message),
      );
      ctx.services.register(
        CAPABILITIES.LOCALIZATION,
        createLocalizer({
          store,
          onMissing: options.onMissing ?? 'key',
          timeZone,
          logger: () => ctx.logger,
        }),
      );
      if (middleware.enabled !== false) {
        ctx.middleware.add(
          localeMiddleware({
            supportedLocales: supported,
            ...(middleware.query === undefined ? {} : { query: middleware.query }),
            ...(middleware.cookie === undefined ? {} : { cookie: middleware.cookie }),
            ...(middleware.exclude === undefined ? {} : { exclude: middleware.exclude }),
            ...(options.tenantLocale === undefined ? {} : { tenantLocale: options.tenantLocale }),
          }),
          { priority, name: 'locale' },
        );
      }
      if (basePath !== undefined) {
        registerCatalogueRoute(ctx.router, basePath, store, cacheControl);
      }
      const source = options.source === undefined
        ? 'static'
        : `injected${options.source.name === undefined ? '' : `:${options.source.name}`}`;
      // No backend remains after `register()`, so `up` is the honest status and
      // the live `data` carries the real facts (the M92 `view` precedent).
      ctx.health.register('localization', () =>
        Promise.resolve({
          status: 'up' as const,
          data: { locales: supported.length, default: supported[0], source },
        }));
    },
  };
}
