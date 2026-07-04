/**
 * Authentication contracts, fulfilled by the AuthPlugin under
 * `CAPABILITIES.AUTH` and `CAPABILITIES.JWT`.
 *
 * @module
 */

/**
 * The authenticated identity attached to a request by authentication
 * middleware.
 *
 * @since 0.1.0
 */
export interface IPrincipal {
  /** Stable subject identifier. */
  readonly id: string;
  /** Role names held by the principal. */
  readonly roles?: readonly string[];
  /** Permission names held by the principal. */
  readonly permissions?: readonly string[];
  /** Additional claims from the credential. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * Options accepted when signing a JWT.
 *
 * @since 0.1.0
 */
export interface JwtSignOptions {
  /** Token lifetime (e.g. `"1h"`, `"7d"`). */
  readonly expiresIn?: string;
  /** Token audience. */
  readonly audience?: string;
  /** Token issuer. */
  readonly issuer?: string;
}

/**
 * JWT sign/verify service.
 *
 * @example
 * ```typescript
 * const jwt = ctx.services.get<IJwtService>(CAPABILITIES.JWT);
 * const token = await jwt.sign({ sub: user.id, roles: user.roles });
 * const payload = await jwt.verify<TokenPayload>(token);
 * ```
 * @since 0.1.0
 */
export interface IJwtService {
  /**
   * Signs a payload into a JWT.
   *
   * @param payload - Claims to embed
   * @param options - Expiry, audience, issuer
   * @returns The signed token
   */
  sign(payload: Readonly<Record<string, unknown>>, options?: JwtSignOptions): Promise<string>;
  /**
   * Verifies a token's signature and validity window.
   *
   * @typeParam T - The expected payload shape
   * @param token - The token to verify
   * @returns The verified payload
   * @throws {Error} If the token is invalid, expired, or tampered with
   */
  verify<T = Readonly<Record<string, unknown>>>(token: string): Promise<T>;
  /**
   * Decodes a token without verifying it. Never trust the result for
   * authorization decisions.
   *
   * @typeParam T - The expected payload shape
   * @param token - The token to decode
   * @returns The decoded payload, or `null` when malformed
   */
  decode<T = Readonly<Record<string, unknown>>>(token: string): T | null;
}
