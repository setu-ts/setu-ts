/**
 * @module
 *
 * The browser-safe formatter subpath — `@setu-ts/localization-plugin/format`.
 *
 * Formatting and locale negotiation with NO runtime dependency outside this
 * directory, so a hydrated component or an SDK client formats with the same
 * code the server used. Import it in a browser bundle; import the package root
 * on the server.
 */
export { format } from './format.ts';
export { negotiateLocale, parseAcceptLanguage } from './negotiate.ts';
export type { AcceptLanguage, FormatOptions, FormatValues } from './types.ts';
