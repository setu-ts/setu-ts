/**
 * Request size middleware factory.
 *
 * Enforces a maximum body size by checking the `Content-Length` header
 * before any body reading. Short-circuits with 413 when the size exceeds
 * the limit, and with 400 when the header is present but not a plain
 * decimal byte count.
 *
 * A request with no `Content-Length` (a chunked body) passes through: this
 * middleware cannot measure a body it has not read. Bound that read with
 * `RuntimePlugin({ maxBodyBytes })` from `@setu-ts/runtime`, set to this
 * middleware's limit or higher; the starters set both.
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { respondWithError } from '@setu-ts/common';

/** Default maximum body size: 1 MiB in bytes. */
const DEFAULT_MAX_BODY_SIZE = 1_048_576;

/** Options for request-size middleware. */
export interface RequestSizeOptions {
  /** Enable/disable request size limiting. Defaults to `true` when present. */
  readonly enabled?: boolean;
  /**
   * Maximum body size in bytes. Default: 1_048_576 (1 MiB). Must be a
   * non-negative integer: `NaN`, `Infinity`, a negative or a fraction throws
   * `RangeError` when the middleware is built (since 0.13.0), because each
   * would silently disable the bound.
   */
  readonly maxBodySize?: number;
}

/**
 * Request size middleware factory.
 *
 * @param options - Request size configuration
 * @returns A middleware function enforcing body size limits
 */
export function requestSizeMiddleware(options: RequestSizeOptions = {}): MiddlewareFunction {
  const enabled = options.enabled ?? true;

  if (!enabled) {
    return (_ctx, next) => next();
  }

  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  // Refused here rather than per request: `NaN` (what `Number()` yields for an
  // unset environment variable) makes every comparison false and `Infinity`
  // admits everything, so either would silently disable the bound.
  if (!Number.isSafeInteger(maxBodySize) || maxBodySize < 0) {
    throw new RangeError(
      `requestSizeMiddleware: maxBodySize must be a non-negative integer, received ` +
        `${String(maxBodySize)}.`,
    );
  }

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const contentLength = ctx.request.headers.get('Content-Length');

    if (contentLength === null) {
      // No Content-Length header — pass through
      await next();
      return;
    }

    // A correct client sends plain decimal digits (RFC 9110 §8.6). Anything
    // else — empty, signed, fractional, exponent, a comma list — is refused
    // rather than treated as absent, which would let it through unbounded.
    const declared = contentLength.trim();
    if (!/^[0-9]+$/.test(declared)) {
      respondWithError(ctx, {
        status: 400,
        title: 'Bad Request',
        detail: 'Content-Length must be a non-negative decimal byte count',
      });
      return;
    }
    const size = Number(declared);

    if (size > maxBodySize) {
      // Short-circuit with 413 — do not call next()
      respondWithError(ctx, {
        status: 413,
        title: 'Payload Too Large',
        detail: `Request body size (${size} bytes) exceeds the maximum allowed size (${maxBodySize} bytes)`,
      });
      return;
    }

    await next();
  };
}
