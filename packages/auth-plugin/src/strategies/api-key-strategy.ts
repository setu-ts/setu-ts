/**
 * API key authentication strategy.
 *
 * @module
 */

import type { IAuthStrategy, IPrincipal, IRequest } from '@setu-ts/common';
import { AuthenticationUnavailableError, AuthPluginConfigurationError } from '../errors.ts';

/**
 * API key strategy options.
 */
export interface ApiKeyStrategyOptions {
  /** Header name for API key (default: 'X-API-Key'); `cookie` in any case is refused. */
  readonly header?: string;
  /**
   * Callback to validate the API key and return a principal. `request` (0.13.0) is the request
   * being authenticated, so a multi-tenant application can bind the key to `request.tenant`.
   * Resolving null rejects the key; throwing signals AuthenticationUnavailableError (503).
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

  /**
   * @param options - Header and application validator
   * @throws {AuthPluginConfigurationError} When the header is Cookie, an ambient credential
   */
  constructor(options: ApiKeyStrategyOptions) {
    this.header = options.header ?? 'X-API-Key';
    if (this.header.toLowerCase() === 'cookie') {
      throw new AuthPluginConfigurationError('API-key header must not be Cookie');
    }
    this.validate = options.validate;
  }

  /**
   * Extract and validate API key from configured header.
   * @param request - Request being authenticated
   * @returns The principal, or null for an absent or invalid key
   * @throws {AuthenticationUnavailableError} When the validator fails
   */
  async authenticate(request: IRequest): Promise<IPrincipal | null> {
    const key = request.headers.get(this.header);
    if (!key) {
      return null;
    }

    try {
      return await this.validate(key, request);
    } catch (error) {
      throw new AuthenticationUnavailableError(error);
    }
  }
}
