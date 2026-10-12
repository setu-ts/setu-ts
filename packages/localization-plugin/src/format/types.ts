/**
 * Types shared by the browser-safe formatter.
 *
 * This module carries types only, and nothing under `src/format/` value-imports
 * anything outside `src/format/` — that is what keeps the subpath's RUNTIME
 * graph empty, and `test/e2e/format-browser-safe.test.ts` enforces it. The
 * message types themselves are declared once, in `@setu-ts/common`, and the
 * formatter reaches them with `import type`, which is erased at runtime.
 *
 * @module
 * @since 0.9.0
 */

/**
 * Placeholder values for a message.
 *
 * A `number` (or `bigint`) is rendered with `Intl.NumberFormat`, a `Date`
 * with `Intl.DateTimeFormat`, a string verbatim, `null`/`undefined` as the
 * empty string, and anything else with `String()`. A plural message reads its
 * form from `count`, which must be a finite number.
 *
 * @since 0.9.0
 */
export type FormatValues = Readonly<Record<string, unknown>>;

/**
 * Options that shape formatting beyond the locale.
 *
 * @since 0.9.0
 */
export interface FormatOptions {
  /**
   * The IANA time zone a `Date` value is formatted in. Omitted, a date
   * formats in the RUNTIME's own zone — so a server in UTC and a browser in
   * `Asia/Kolkata` print different dates for the same instant. Pass the same
   * value on both sides when the text must agree.
   */
  readonly timeZone?: string;
}

/**
 * A parsed `Accept-Language` header.
 *
 * @since 0.9.0
 */
export interface AcceptLanguage {
  /**
   * Ranges with `q > 0`, highest preference first (stable on ties); a `*`
   * range is kept in place.
   */
  readonly preferred: readonly string[];
  /** Ranges the client sent with `q=0` — explicitly NOT acceptable. */
  readonly excluded: readonly string[];
}
