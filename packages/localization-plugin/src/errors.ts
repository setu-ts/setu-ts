/**
 * Errors the localization plugin throws.
 *
 * `MissingPluralCountError` lives in the formatter (`format/format.ts`) because
 * the browser-safe subpath may import nothing from here; it is re-exported from
 * the package root.
 *
 * @module
 * @since 0.9.0
 */

/** Longest key echoed into an error message. A key can be caller text. */
const KEY_ECHO_LIMIT = 64;

/** Truncates a key for an error message. */
function echo(key: string): string {
  return key.length > KEY_ECHO_LIMIT ? `${key.slice(0, KEY_ECHO_LIMIT)}…` : key;
}

/**
 * Thrown by `t()` for a key no catalogue defines, when the plugin is
 * configured with `onMissing: 'throw'`. The default answers the key itself.
 *
 * @since 0.9.0
 */
export class MissingMessageError extends Error {
  /** The missing key. */
  readonly key: string;
  /** The locale it was looked up in. */
  readonly locale: string;

  /**
   * Creates the error for a key no catalogue defines.
   *
   * @param key - The missing key
   * @param locale - The locale it was looked up in
   */
  constructor(key: string, locale: string) {
    super(`No catalogue defines message "${echo(key)}" (locale ${locale}).`);
    this.name = 'MissingMessageError';
    this.key = key;
    this.locale = locale;
  }
}

/**
 * Thrown by `ILocalizer.forLocale` for a tag outside the supported set. Callers
 * pass configuration there, never client text, so this is a programming error.
 *
 * @since 0.9.0
 */
export class UnsupportedLocaleError extends Error {
  /** The refused tag. */
  readonly locale: string;

  /**
   * Creates the error for a tag outside the supported set.
   *
   * @param locale - The refused tag
   * @param supported - The supported set, named in the message
   */
  constructor(locale: string, supported: readonly string[]) {
    super(
      `Locale "${echo(locale)}" is not supported; supported locales are ${supported.join(', ')}.`,
    );
    this.name = 'UnsupportedLocaleError';
    this.locale = locale;
  }
}
