/**
 * The malformed request body error (X37-1, M90f).
 *
 * `IRequest.json()` has three implementations — the served HTTP path
 * (`@setu-ts/runtime`), the kernel's `inject()`, and `@setu-ts/testing`'s
 * `MockRequest` — and before M90f each raised the platform `SyntaxError`
 * directly. A parse failure is a condition the **caller** caused, so it must
 * answer `400`, but a bare `SyntaxError` carries no status and reaches
 * `errorHandler` as a plain `Error`: normalized to a masked `500`, which by
 * convention means the opposite of what happened. The class exists so all
 * three producers reject with ONE branded value and the boundary has one
 * thing to read (§2.2: `runtime` may not import `@setu-ts/exceptions`, so the
 * error lives in `common` beside the brand it carries).
 *
 * @module
 */
import { withHttpStatusHint } from './status-hint.ts';

/**
 * Thrown when a request body cannot be parsed as JSON.
 *
 * The `cause` is the platform `SyntaxError` the parse produced — kept for the
 * log, never served: the caller-facing sentence is the fixed `detail` written
 * here, composed only of framework-chosen words, so the masking exemption the
 * brand earns cannot disclose body content (§3.7).
 *
 * @example
 * ```typescript
 * try {
 *   const body = await ctx.request.json();
 * } catch (error) {
 *   if (error instanceof MalformedRequestBodyError) {
 *     // Answer 400; `error.cause` is the underlying SyntaxError.
 *   }
 * }
 * ```
 *
 * @since 0.5.0
 */
export class MalformedRequestBodyError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'MalformedRequestBodyError';

  /**
   * Builds the error for one failed parse.
   *
   * @param cause - The platform `SyntaxError` the JSON parse produced
   */
  constructor(cause: unknown) {
    super('The request body is not valid JSON.', { cause });
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: 'The request body could not be parsed as JSON.',
    });
  }
}
