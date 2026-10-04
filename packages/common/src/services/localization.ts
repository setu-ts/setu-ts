/**
 * Localization contract — the port that turns a message key and its values
 * into user-facing text in one locale, served by the localization plugin
 * (`@setu-ts/localization-plugin`).
 *
 * The contract lives here, not in the plugin, so a plugin that formats text
 * for a person (mail, notification, an error page) can resolve it under
 * `CAPABILITIES.LOCALIZATION` without importing the localization plugin
 * (AI_GUIDELINES §2.2).
 *
 * @module
 * @since 0.9.0
 */

/**
 * A plural message: one string per CLDR plural category.
 *
 * `other` is required because every locale's rules can select it. A form is
 * chosen with `Intl.PluralRules(locale).select(count)`, so `zero` is selected
 * only in locales whose rules produce it — in English `count: 0` selects
 * `other`.
 *
 * @example
 * ```typescript
 * const items: PluralForms = { one: '{count} item', other: '{count} items' };
 * ```
 * @since 0.9.0
 */
export interface PluralForms {
  /** The `zero` category (e.g. Arabic, Latvian). */
  readonly zero?: string;
  /** The `one` category. */
  readonly one?: string;
  /** The `two` category (e.g. Arabic, Welsh). */
  readonly two?: string;
  /** The `few` category (e.g. Polish, Czech). */
  readonly few?: string;
  /** The `many` category (e.g. Polish, Arabic). */
  readonly many?: string;
  /** The fallback category every locale can select. */
  readonly other: string;
}

/**
 * One catalogue entry: a string with `{name}` placeholders, or a plural record
 * whose selected form is formatted the same way.
 *
 * @since 0.9.0
 */
export type LocalizationMessage = string | PluralForms;

/**
 * One locale's messages, keyed by message key. Keys are flat; a dotted key
 * (`'cart.empty'`) is an ordinary key, not a path.
 *
 * @since 0.9.0
 */
export type MessageCatalogue = Readonly<Record<string, LocalizationMessage>>;

/**
 * Localization contract — looks up and formats messages for one locale.
 *
 * Registered under `CAPABILITIES.LOCALIZATION` (`'localization'`), bound to
 * the application's default locale. A request-bound view comes from
 * {@linkcode ILocalizer.forLocale} with the request's resolved
 * `IRequest.locale`, which is what the localization plugin's
 * `localizerFor(ctx)` does.
 *
 * Formatting substitutes text and escapes NOTHING: escaping belongs to the
 * runtime that renders the result (the JSX runtime, the `html` tagged
 * template), exactly as for `IViewEngine.render`.
 *
 * @example
 * ```typescript
 * import { CAPABILITIES } from '@setu-ts/common';
 *
 * const localizer = ctx.services.get<ILocalizer>(CAPABILITIES.LOCALIZATION);
 * const greeting = localizer.forLocale('de').t('greeting', { name: 'Ada' });
 * ```
 * @since 0.9.0
 */
export interface ILocalizer {
  /** The BCP 47 tag this localizer formats in. */
  readonly locale: string;
  /** Every supported tag, the default first. */
  readonly locales: readonly string[];
  /**
   * Looks up `key` in this localizer's locale and formats it with `values`.
   *
   * A key absent from every catalogue answers the key itself (and is logged
   * once), unless the implementation was configured to throw — a request
   * never fails over a translation gap by default.
   *
   * @param key - The message key
   * @param values - Placeholder values; a plural message requires a finite
   *   numeric `count`
   * @returns The formatted text
   */
  t(key: string, values?: Readonly<Record<string, unknown>>): string;
  /**
   * Returns a localizer bound to another SUPPORTED locale.
   *
   * Callers pass configuration (a resolved request locale, a user's stored
   * preference already matched against the supported set), never raw user
   * input, so an unsupported tag is a programming error and throws.
   *
   * @param tag - A tag from {@linkcode ILocalizer.locales}
   * @returns A localizer bound to `tag`
   * @throws {Error} If `tag` is not a supported locale
   */
  forLocale(tag: string): ILocalizer;
}
