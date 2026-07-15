/**
 * API key authentication strategy.
 *
 * @module
 */

import type { IAuthStrategy, IPrincipal, IRequest } from '@hono-enterprise/common';

/**
 * API key strategy options.
 */
export interface ApiKeyStrategyOptions {
  /** Header name for API key (default: 'X-API-Key'). */
  readonly header?: string;
  /** Callback to validate the API key and return a principal. */
  readonly validate: (key: string) => Promise<IPrincipal | null>;
}

/**
 * API key authentication strategy that extracts keys from headers.
 */
export class ApiKeyStrategy implements IAuthStrategy {
  readonly name = 'api-key';
  private readonly header: string;
  private readonly validate: (key: string) => Promise<IPrincipal | null>;

  constructor(options: ApiKeyStrategyOptions) {
    this.header = options.header ?? 'X-API-Key';
    this.validate = options.validate;
  }

  /**
   * Extract and validate API key from configured header.
   */
  async authenticate(request: IRequest): Promise<IPrincipal | null> {
    const key = request.headers.get(this.header);
    if (!key) {
      return null;
    }

    try {
      return await this.validate(key);
    } catch {
      // Validation error - return null (don't throw)
      return null;
    }
  }
}
