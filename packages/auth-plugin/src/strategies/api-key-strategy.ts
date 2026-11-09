/**
 * API key authentication strategy.
 *
 * @module
 */

import type { IAuthStrategy, IPrincipal, IRequest } from '@setu-ts/common';

/**
 * API key strategy options.
 */
export interface ApiKeyStrategyOptions {
  /** Header name for API key (default: 'X-API-Key'). */
  readonly header?: string;
  /**
   * Callback to validate the API key and return a principal. `request` (0.13.0) is the request
   * being authenticated, so a multi-tenant application can bind the key to `request.tenant`.
   */
  readonly validate: (key: string, request?: IRequest) => Promise<IPrincipal | null>;
}

/**
 * API key authentication strategy that extracts keys from headers.
 */
export class ApiKeyStrategy implements IAuthStrategy {
  readonly name = 'api-key';
  readonly credential = 'header' as const;
  private readonly header: string;
  private readonly validate: (key: string, request?: IRequest) => Promise<IPrincipal | null>;

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
      return await this.validate(key, request);
    } catch {
      // Validation error - return null (don't throw)
      return null;
    }
  }
}
