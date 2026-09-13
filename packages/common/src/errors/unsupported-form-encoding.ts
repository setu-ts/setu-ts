/**
 * The unsupported-form-encoding rejection behind `parseFormBody` and
 * `IRequest.formData?()`.
 *
 * @module
 */

import { withHttpStatusHint } from './status-hint.ts';

/**
 * Raised when a request body is not a form encoding the framework can parse:
 * a JSON body, a missing content-type, or a `multipart/form-data` type
 * carrying no `boundary=`.
 *
 * Self-branded `415 Unsupported Media Type` in its own constructor — the
 * `MalformedRequestBodyError` precedent (X37-1) — so a body that is not a
 * form is answered `415` in the application's configured format instead of
 * the masked `500` an unbranded throw from body depth would produce. A
 * handler that catches its own `formData()` rejection keeps full control of
 * what is served; the class is exported so that catch can use `instanceof`.
 *
 * It is deliberately NOT thrown for a multipart body the parser cannot make
 * sense of: that yields an empty `FormBody`, the promoted parser's released
 * behaviour, documented on the accessor rather than converted into a status
 * here.
 *
 * @example
 * ```typescript
 * try {
 *   const form = await ctx.request.formData();
 * } catch (error) {
 *   if (error instanceof UnsupportedFormEncodingError) {
 *     // Not a form body — answer 415 or read the body another way.
 *   }
 * }
 * ```
 * @since 0.5.0
 */
export class UnsupportedFormEncodingError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'UnsupportedFormEncodingError';

  /**
   * Builds the rejection for a content-type that is neither form encoding.
   *
   * The caller-facing detail names the two supported encodings and never
   * echoes the request's own content-type value: it is client-controlled,
   * and the detail is served verbatim in an unauthenticated response body.
   */
  constructor() {
    super(
      'The request body is not an application/x-www-form-urlencoded or multipart/form-data body.',
    );
    withHttpStatusHint(this, {
      status: 415,
      title: 'Unsupported Media Type',
      detail:
        'The request body is not an application/x-www-form-urlencoded or multipart/form-data body.',
    });
  }
}
