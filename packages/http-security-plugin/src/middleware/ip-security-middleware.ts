/**
 * IP security middleware factory.
 *
 * Resolves the client IP address and publishes it to
 * `ctx.state.set('clientIp', ip)`. Does not short-circuit.
 *
 * **`trustProxy` is the only working source since M23.** The web-standard
 * `fetch` mapping the HTTP adapters use cannot populate `IRequest.ip` — a web
 * `Request` carries no peer address — so the `request.ip` fallback below is
 * vestigial and `clientIp` is `undefined` unless `trustProxy` is on and the
 * configured header is present. The fallback is retained for a custom adapter
 * that does set `IRequest.ip`.
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
   *
   * WARNING: only enable behind a trusted proxy that overwrites the header —
   * a client can otherwise spoof it. Note that with `false`, `clientIp` is
   * `undefined` on all first-party adapters (see the module note).
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

    // Fallback to request.ip when trustProxy is false or the header is absent
    // or empty. The first-party adapters never set it (see the module note), so
    // this resolves to `undefined` there.
    if (!ip) {
      ip = ctx.request.ip;
    }

    // Publish the resolved IP to state (even if undefined)
    ctx.state.set('clientIp', ip);

    // Never short-circuit
    await next();
  };
}
