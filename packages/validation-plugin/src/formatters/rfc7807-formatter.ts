/**
 * RFC 7807 Problem Details validation error formatter (deprecated).
 *
 * RFC 7807 was obsoleted by [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
 * in July 2023.
 *
 * This is a **deprecated alias bound to the same object** as
 * {@linkcode rfc9457Formatter}, not a second implementation: this formatter's
 * `type` is a semantic URI that was never derived from the status code, so its
 * body was already valid under RFC 9457 and there is no earlier behavior to
 * preserve separately. Binding one reference also keeps the media-type identity
 * check in `validation-middleware.ts` correct for both spellings.
 *
 * @module
 */
import { rfc9457Formatter } from './rfc9457-formatter.ts';
import type { ValidationErrorFormatter } from './error-formatter.ts';

/**
 * Format validation issues as RFC 7807 Problem Details.
 *
 * @deprecated RFC 7807 was obsoleted by RFC 9457. Use `rfc9457Formatter`
 * instead, or the `'rfc9457'` format alias. The emitted body is identical, so
 * migrating changes nothing on the wire. Will be removed in v1.0.0.
 * @example
 * ```typescript
 * // Before
 * app.register(ValidationPlugin({ errorFormat: 'rfc7807' }));
 * // After — byte-identical response
 * app.register(ValidationPlugin({ errorFormat: 'rfc9457' }));
 * ```
 * @since 0.1.0
 */
export const rfc7807Formatter: ValidationErrorFormatter = rfc9457Formatter;
