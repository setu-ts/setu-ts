/**
 * Authentication service that coordinates strategies.
 *
 * @module
 */

import type { IAuthService, IAuthStrategy, IPrincipal, IRequest } from '@hono-enterprise/common';

/**
 * Authentication service implementing IAuthService.
 * Coordinates passive strategies for authenticate and delegates
 * credential verification to the local strategy.
 */
export class AuthService implements IAuthService {
  private readonly strategies: readonly IAuthStrategy[];
  private readonly localStrategy: LocalStrategy;

  constructor(
    strategies: readonly IAuthStrategy[],
    localStrategy: LocalStrategy,
  ) {
    this.strategies = strategies;
    this.localStrategy = localStrategy;
  }

  /**
   * Run configured passive strategies in order.
   * First non-null principal wins, null if none match.
   */
  async authenticate(request: IRequest): Promise<IPrincipal | null> {
    for (const strategy of this.strategies) {
      const principal = await strategy.authenticate(request);
      if (principal !== null) {
        return principal;
      }
    }
    return null;
  }

  /**
   * Verify credentials for login flow (delegates to LocalStrategy).
   */
  async verifyCredentials(
    credentials: { readonly identifier: string; readonly secret: string },
  ): Promise<IPrincipal | null> {
    return this.localStrategy.verify(credentials.identifier, credentials.secret);
  }
}

/**
 * Local strategy for credential-based authentication.
 * Holds the app-supplied verify callback.
 */
export class LocalStrategy {
  private readonly verifyCallback: (
    identifier: string,
    secret: string,
  ) => Promise<IPrincipal | null>;

  constructor(verifyCallback: (identifier: string, secret: string) => Promise<IPrincipal | null>) {
    this.verifyCallback = verifyCallback;
  }

  /**
   * Verify credentials by delegating to the app-supplied callback.
   */
  async verify(
    identifier: string,
    secret: string,
  ): Promise<IPrincipal | null> {
    return this.verifyCallback(identifier, secret);
  }
}
