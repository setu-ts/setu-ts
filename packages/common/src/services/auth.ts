/**
 * Authentication contracts, fulfilled by the AuthPlugin under
 * `CAPABILITIES.AUTH` and `CAPABILITIES.JWT`.
 *
 * @module
 */

import type { IRequest } from '../http.ts';

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

/**
 * Role definition for RBAC configuration.
 *
 * @since 0.1.0
 */
export interface RoleDefinition {
  /** Permissions granted by this role. */
  readonly permissions?: readonly string[];
  /** Role names this role inherits from (transitive). */
  readonly inherits?: readonly string[];
}

/**
 * RBAC configuration for role hierarchy and permissions.
 *
 * @since 0.1.0
 */
export interface RbacConfig {
  /** Role definitions keyed by role name. */
  readonly roles: Readonly<Record<string, RoleDefinition>>;
}

/**
 * Authentication strategy interface. Implementations extract credentials
 * from a request and return a principal, or `null` if the strategy
 * does not apply.
 *
 * @since 0.1.0
 */
export interface IAuthStrategy {
  /** Strategy name for identification. */
  readonly name: string;
  /**
   * Attempt to authenticate the request.
   *
   * @param request - The incoming request
   * @returns The authenticated principal, or `null` if no credentials found
   */
  authenticate(request: IRequest): Promise<IPrincipal | null>;
}

/**
 * Authentication service that coordinates strategies and provides
 * credential verification for login flows.
 *
 * @since 0.1.0
 */
export interface IAuthService {
  /**
   * Run configured passive strategies to authenticate a request.
   *
   * @param request - The incoming request
   * @returns The authenticated principal, or `null` if unauthenticated
   */
  authenticate(request: IRequest): Promise<IPrincipal | null>;
  /**
   * Verify credentials for a login flow (e.g., username/password).
   *
   * @param credentials - The credentials to verify
   * @returns The authenticated principal, or `null` if invalid
   */
  verifyCredentials(
    credentials: { readonly identifier: string; readonly secret: string },
  ): Promise<IPrincipal | null>;
}

/**
 * Authorization service for RBAC with role hierarchy.
 *
 * @since 0.1.0
 */
export interface IAuthorizationService {
  /**
   * Check if a principal has a specific role (including inherited roles).
   *
   * @param principal - The principal to check
   * @param role - The role name to check
   * @returns `true` if the principal has the role
   */
  hasRole(principal: IPrincipal, role: string): boolean;
  /**
   * Check if a principal has a specific permission (direct or via role hierarchy).
   *
   * @param principal - The principal to check
   * @param permission - The permission to check
   * @returns `true` if the principal has the permission
   */
  hasPermission(principal: IPrincipal, permission: string): boolean;
  /**
   * Check if a principal has any of the specified roles.
   *
   * @param principal - The principal to check
   * @param roles - The role names to check
   * @returns `true` if the principal has any of the roles
   */
  hasAnyRole(principal: IPrincipal, roles: readonly string[]): boolean;
  /**
   * Check if a principal has all of the specified permissions.
   *
   * @param principal - The principal to check
   * @param permissions - The permission names to check
   * @returns `true` if the principal has all permissions
   */
  hasAllPermissions(principal: IPrincipal, permissions: readonly string[]): boolean;
}
