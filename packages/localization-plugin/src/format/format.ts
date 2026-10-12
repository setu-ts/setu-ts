/**
 * The message formatter — `{name}` placeholders, CLDR plural records, and
 * `Intl` number and date rendering.
 *
 * Shared by the server (`ILocalizer.t`) and a browser (the `/format`
 * subpath), so both run ONE implementation. That is a promise about code, not
 * about output: `Intl` text depends on each runtime's ICU data, and a `Date`
 * formats in the runtime's own zone unless a `timeZone` is passed.
 *
 * The formatter escapes NOTHING. A value is substituted as text, and escaping
 * belongs to whatever renders the result — the JSX runtime or the `html`
 * tagged template — exactly as for `IViewEngine.render`.
 *
 * @module
 * @since 0.9.0
 */
import type { LocalizationMessage, PluralForms } from '@setu-ts/common';

import type { FormatOptions, FormatValues } from './types.ts';

/**
 * Thrown when a plural message is formatted without a finite numeric `count`.
 *
 * The plural form cannot be chosen without a count, and guessing `other`
 * would print "1 items" silently, so the absence is a programming error.
 *
 * @since 0.9.0
 */
export class MissingPluralCountError extends Error {
  /** The message key, when the caller knew it (the localizer always does). */
  readonly key: string | undefined;

  /**
   * Creates the error for a plural message formatted without a count.
   *
   * @param key - The message key, when known
   * @param options - Standard error options (a `cause`)
   */
  constructor(key?: string, options?: ErrorOptions) {
    super(
      key === undefined
        ? 'A plural message needs a finite numeric `count` value.'
        : `Plural message "${key}" needs a finite numeric \`count\` value.`,
      options,
    );
    this.name = 'MissingPluralCountError';
    this.key = key;
  }
}

/** Each `Intl` cache holds at most this many entries, oldest evicted. */
const CACHE_LIMIT = 64;

/**
 * Bounded caches keyed by EVERY argument that shapes the instance. A date
 * formatter is keyed by locale AND zone: keyed by locale alone it would hand
 * back a formatter built for whichever zone was asked first. The bound exists
 * because a browser caller may pass any tag, not only configured ones.
 */
const pluralCache = new Map<string, Intl.PluralRules>();
const numberCache = new Map<string, Intl.NumberFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();

function cached<T>(cache: Map<string, T>, key: string, create: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const value = create();
  if (cache.size >= CACHE_LIMIT) {
    // A Map iterates in insertion order, so the first key is the oldest.
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, value);
  return value;
}

/**
 * The number of cached date formatters. Internal — read by the test that
 * pins the bound.
 *
 * @returns The current date-cache size
 */
export function dateCacheSize(): number {
  return dateCache.size;
}

/** Renders one placeholder value as text. */
function render(value: unknown, locale: string, timeZone: string | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return cached(numberCache, locale, () => new Intl.NumberFormat(locale)).format(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return String(value);
    }
    // `|` cannot occur in a BCP 47 tag or an IANA zone name, so the key is
    // unambiguous.
    const key = `${locale}|${timeZone ?? ''}`;
    return cached(
      dateCache,
      key,
      () => new Intl.DateTimeFormat(locale, timeZone === undefined ? undefined : { timeZone }),
    ).format(value);
  }
  return String(value);
}

/** `{name}` — a placeholder name is letters, digits, `_`, `.` or `-`. */
const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;

/** Selects the plural form for `count`, falling back to `other`. */
function selectForm(forms: PluralForms, count: number, locale: string): string {
  const category = cached(pluralCache, locale, () => new Intl.PluralRules(locale)).select(
    count,
  ) as keyof PluralForms;
  return forms[category] ?? forms.other;
}

/**
 * Formats one message for a locale.
 *
 * A string message has each `{name}` replaced by `values[name]`, rendered per
 * {@linkcode FormatValues}; a placeholder whose name is absent from `values` is
 * left VERBATIM. A plural message selects its form with
 * `Intl.PluralRules(locale).select(values.count)` — `other` when the locale's
 * rules pick a form the message lacks — then formats it the same way. In
 * English `count: 0` selects `other`, not `zero`.
 *
 * @param message - The message to format
 * @param values - Placeholder values
 * @param locale - The BCP 47 tag to format in
 * @param options - Formatting options (`timeZone` for dates)
 * @returns The formatted text, unescaped
 * @throws {MissingPluralCountError} If `message` is plural and `values.count`
 *   is not a finite number
 * @example
 * ```typescript
 * format({ one: '{count} item', other: '{count} items' }, { count: 3 }, 'en');
 * // '3 items'
 * format('Hello {name}', { name: 'Ada' }, 'en'); // 'Hello Ada'
 * ```
 * @since 0.9.0
 */
export function format(
  message: LocalizationMessage,
  values: FormatValues,
  locale: string,
  options: FormatOptions = {},
): string {
  let text: string;
  if (typeof message === 'string') {
    text = message;
  } else {
    const count = values.count;
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      throw new MissingPluralCountError();
    }
    text = selectForm(message, count, locale);
  }
  return text.replace(
    PLACEHOLDER,
    (whole, name: string) =>
      Object.hasOwn(values, name) ? render(values[name], locale, options.timeZone) : whole,
  );
}
