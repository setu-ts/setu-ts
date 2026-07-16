/**
 * IP security middleware factory.
 *
 * Resolves the client IP address and publishes it to
 * `ctx.state.set('clientIp', ip)`. Does not short-circuit.
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction } from '@hono-enterprise/common';

/** Options for IP security middleware. */
export interface IpSecurityOptions {
  /** Enable/disable IP resolution. Defaults to `true` when present. */
  readonly enabled?: boolean;
  /**
   * When `true`, read the client IP from the proxy header instead of
   * `request.ip`. Requires a trusted reverse proxy. Default: `false`.
   * WARNING: Only enable behind a trusted proxy that validates the header.
   */
  readonly trustProxy?: boolean;
  /**
   * The header name to read when `trustProxy` is `true`. Default: `X-Forwarded-For`.
   * The leftmost (first) address is taken as the client IP.
   */
  readonly ipHeader?: string;
}

/**
 * IP security middleware factory.
 *
 * @param options - IP security configuration
 * @returns A middleware function that resolves and publishes the client IP
 */
export function ipSecurityMiddleware(options: IpSecurityOptions = {}): MiddlewareFunction {
  const enabled = options.enabled ?? true;

  if (!enabled) {
    return (_ctx, next) => next();
  }

  const trustProxy = options.trustProxy ?? false;
  const ipHeader = options.ipHeader ?? 'X-Forwarded-For';

  return async (
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void> => {
    let ip: string | undefined;

    if (trustProxy) {
      const headerValue = ctx.request.headers.get(ipHeader);
      if (headerValue) {
        // Take the leftmost (first) address from X-Forwarded-For
        ip = headerValue.split(',')[0]?.trim();
        if (!ip) {
          ip = undefined;
        }
      }
    }

    // Fallback to request.ip when trustProxy is false or the header is absent/empty
    if (!ip) {
      ip = ctx.request.ip;
    }

    // Publish the resolved IP to state (even if undefined)
    ctx.state.set('clientIp', ip);

    // Never short-circuit
    await next();
  };
}
