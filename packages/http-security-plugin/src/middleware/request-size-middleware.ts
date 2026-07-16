/**
 * Request size middleware factory.
 *
 * Enforces a maximum body size by checking the `Content-Length` header
 * before any body reading. Short-circuits with 413 when the size exceeds
 * the limit.
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction } from '@hono-enterprise/common';

/** Default maximum body size: 1 MiB in bytes. */
const DEFAULT_MAX_BODY_SIZE = 1_048_576;

/** Options for request-size middleware. */
export interface RequestSizeOptions {
  /** Enable/disable request size limiting. Defaults to `true` when present. */
  readonly enabled?: boolean;
  /**
   * Maximum body size in bytes. Default: 1_048_576 (1 MiB).
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

  return async (
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void> => {
    const contentLength = ctx.request.headers.get('Content-Length');

    if (contentLength === null) {
      // No Content-Length header — pass through
      await next();
      return;
    }

    const size = Number(contentLength);

    // Non-numeric or negative values are treated as absent (pass through)
    if (!Number.isFinite(size) || size < 0) {
      await next();
      return;
    }

    if (size > maxBodySize) {
      // Short-circuit with 413 — do not call next()
      ctx.response.status(413).json({
        error: 'Payload Too Large',
        message:
          `Request body size (${size} bytes) exceeds the maximum allowed size (${maxBodySize} bytes)`,
      });
      return;
    }

    await next();
  };
}
