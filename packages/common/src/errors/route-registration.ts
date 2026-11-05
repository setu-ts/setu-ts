import type { HttpMethod } from '../types.ts';

/**
 * A route refused at registration, with machine-readable routing context.
 * @example
 * ```typescript
 * if (error instanceof RouteRegistrationError) report(error.reason, error.path);
 * ```
 * @since 0.12.0
 */
export class RouteRegistrationError extends Error {
  /** The router contract violated by this registration. */
  readonly reason: 'regex-parameter' | 'unsupported-pattern' | 'duplicate';
  /** HTTP method being registered. */
  readonly method: HttpMethod;
  /** Path supplied to the router. */
  readonly path: string;

  /**
   * @param reason - The refusal category
   * @param method - The route's HTTP method
   * @param path - The route's path
   * @param message - Human-readable refusal, optionally including controller context
   * @param options - Original refusal when enriching a diagnostic
   */
  constructor(
    reason: 'regex-parameter' | 'unsupported-pattern' | 'duplicate',
    method: HttpMethod,
    path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RouteRegistrationError';
    this.reason = reason;
    this.method = method;
    this.path = path;
  }
}
