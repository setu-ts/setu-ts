/**
 * Authentication service that coordinates strategies.
 *
 * @module
 */

import type { IAuthService, IAuthStrategy, IPrincipal, IRequest } from '@setu-ts/common';

/**
 * Authentication service implementing IAuthService.
 * Coordinates passive strategies for authenticate and delegates
 * credential verification to the local strategy.
 */
export class AuthService implements IAuthService {
  private readonly strategies: readonly IAuthStrategy[];
  private readonly localStrategy: LocalStrategy;

  constructor(strategies: readonly IAuthStrategy[], localStrategy: LocalStrategy) {
    this.strategies = strategies;
    this.localStrategy = localStrategy;
  }

  /**
   * Run configured passive strategies in order.
   * First non-null principal wins, null if none match.
   */
  async authenticate(request: IRequest): Promise<IPrincipal | null> {
    return (await this.authenticateWithSource(request))?.principal ?? null;
  }

  /**
   * The one strategy loop, returning the first match WITH the credential source of the
   * strategy that produced it (`strategy.credential`, absent treated as `'cookie'` —
   * fail closed). Internal to the plugin: `authMiddleware` records the source under
   * `CREDENTIAL_SOURCE_STATE_KEY` so form CSRF can exempt only header-credential
   * authentication; a replaced `IAuthService` without this method simply records no
   * source and every request stays verified.
   */
  async authenticateWithSource(
    request: IRequest,
  ): Promise<{ principal: IPrincipal; credential: 'header' | 'cookie' } | null> {
    for (const strategy of this.strategies) {
      const principal = await strategy.authenticate(request);
      if (principal !== null) {
        return { principal, credential: strategy.credential ?? 'cookie' };
      }
    }
    return null;
  }

  /**
   * Verify credentials for login flow (delegates to LocalStrategy).
   */
  verifyCredentials(credentials: {
    readonly identifier: string;
    readonly secret: string;
  }): Promise<IPrincipal | null> {
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
  verify(identifier: string, secret: string): Promise<IPrincipal | null> {
    return this.verifyCallback(identifier, secret);
  }
}
