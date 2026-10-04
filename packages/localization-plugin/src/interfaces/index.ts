/**
 * Option and port types for the localization plugin.
 *
 * @module
 * @since 0.9.0
 */
import type { ITenant, MessageCatalogue, PathPattern } from '@setu-ts/common';

/**
 * A source that loads every catalogue once, during `register()` — the seam for
 * catalogues kept in a database, a KV store, or a remote service.
 *
 * Loading happens once: a request never waits on it, and a rejection fails
 * startup rather than a request. The result is validated exactly as static
 * `catalogues` are.
 *
 * @example
 * ```typescript
 * const source: IMessageSource = {
 *   name: 'kv',
 *   load: async () => JSON.parse(await kv.get('catalogues') ?? '{}'),
 * };
 * ```
 * @since 0.9.0
 */
export interface IMessageSource {
  /** A name reported by the `localization` health indicator. */
  readonly name?: string;
  /**
   * Loads every catalogue, keyed by locale tag.
   *
   * @returns The catalogues
   */
  load(): Promise<Readonly<Record<string, MessageCatalogue>>>;
}

/**
 * Options for {@linkcode localeMiddleware}: how the request locale is resolved.
 *
 * Resolution tries, in order, the query parameter, the cookie,
 * `Accept-Language`, `tenantLocale`, and finally the default — the first
 * entry of `supportedLocales`. Every candidate is matched against
 * `supportedLocales` only.
 *
 * @since 0.9.0
 */
export interface LocaleMiddlewareOptions {
  /** The supported BCP 47 tags; the first is the default. */
  readonly supportedLocales: readonly string[];
  /** The query parameter that selects a locale; `false` disables it. Default `'locale'`. */
  readonly query?: string | false;
  /**
   * The cookie that selects a locale; `false` disables it. Default
   * `'setu_locale'`. While enabled, every governed response carries
   * `Vary: Cookie` — correct, and costly for CDN caching, which is why it can
   * be turned off.
   */
  readonly cookie?: string | false;
  /**
   * Paths the middleware skips entirely: no resolution, no headers. Default
   * the six operational paths (`/live`, `/ready`, `/health`, `/metrics`,
   * `/openapi.json`, `/docs`); `[]` disables exclusion.
   */
  readonly exclude?: readonly PathPattern[];
  /**
   * A tenant's default locale, consulted after `Accept-Language` when the
   * request carries a resolved tenant (the tenancy middleware runs at 40,
   * before this one at 45). Its answer is matched like any candidate. A throw
   * propagates: this is application code, not client input.
   */
  readonly tenantLocale?: (tenant: ITenant) => string | undefined;
}

/**
 * Options for `LocalizationPlugin`. Exactly one of `catalogues` (static) and
 * `source` (loaded once at `register()`) is required; supplying both, or
 * neither, is a compile error.
 *
 * @since 0.9.0
 */
export type LocalizationPluginOptions =
  & {
    /** The supported BCP 47 tags; the first is the default. */
    readonly supportedLocales: readonly string[];
    /**
     * Accept a supported locale whose catalogue lacks keys the default locale
     * defines: warned once per locale at `register()`, served from the default
     * locale at lookup. Default `false` — an incomplete catalogue fails startup.
     */
    readonly allowPartialCatalogues?: boolean;
    /**
     * What `t()` does for a key no catalogue has: `'key'` answers the key and
     * warns once (default); `'throw'` throws `MissingMessageError`, for tests
     * and CI.
     */
    readonly onMissing?: 'key' | 'throw';
    /**
     * The IANA time zone `Date` values are formatted in. Omitted, the runtime's
     * own zone is used. A browser formatting the same messages should pass the
     * same value.
     */
    readonly timeZone?: string;
    /** A tenant's default locale; see {@linkcode LocaleMiddlewareOptions.tenantLocale}. */
    readonly tenantLocale?: (tenant: ITenant) => string | undefined;
    /** How the global resolution middleware is registered. */
    readonly middleware?: {
      /** Register the global middleware. Default `true`. */
      readonly enabled?: boolean;
      /** Its priority. Default `45` — after tenant (40), before logging (50). */
      readonly priority?: number;
      /** See {@linkcode LocaleMiddlewareOptions.query}. */
      readonly query?: string | false;
      /** See {@linkcode LocaleMiddlewareOptions.cookie}. */
      readonly cookie?: string | false;
      /** See {@linkcode LocaleMiddlewareOptions.exclude}. */
      readonly exclude?: readonly PathPattern[];
    };
    /**
     * Serve each supported locale's catalogue as JSON at
     * `GET <basePath>/:locale`, for a browser that formats after hydration. Off
     * when absent.
     */
    readonly exposeCatalogues?: {
      /**
       * The route prefix: one or more plain path segments such as `/i18n` —
       * letters, digits, `.`, `_`, `~` or `-` — and never the root.
       */
      readonly basePath: string;
      /**
       * The `Cache-Control` value. Default `'private, max-age=3600'` — never
       * shared, because a session may refresh its cookie on this response. Set
       * `'public, …'` only when no session cookie reaches the route.
       */
      readonly cacheControl?: string;
    };
  }
  & (
    | {
      /** The catalogues, keyed by locale tag. */
      readonly catalogues: Readonly<Record<string, MessageCatalogue>>;
      readonly source?: never;
    }
    | {
      /** A source that loads the catalogues once at `register()`. */
      readonly source: IMessageSource;
      readonly catalogues?: never;
    }
  );
