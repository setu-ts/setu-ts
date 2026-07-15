/**
 * JWT authentication strategy.
 *
 * @module
 */

import type { IAuthStrategy, IJwtService, IPrincipal, IRequest } from '@hono-enterprise/common';

/**
 * JWT strategy options.
 */
export interface JwtStrategyOptions {
  readonly jwtService: IJwtService;
  readonly header?: string;
  readonly scheme?: string;
}

/**
 * JWT authentication strategy that extracts Bearer tokens from headers.
 */
export class JwtStrategy implements IAuthStrategy {
  readonly name = 'jwt';
  private readonly jwtService: IJwtService;
  private readonly header: string;
  private readonly scheme: string;

  constructor(options: JwtStrategyOptions) {
    this.jwtService = options.jwtService;
    this.header = options.header ?? 'authorization';
    this.scheme = options.scheme ?? 'bearer';
  }

  /**
   * Extract and verify JWT from Authorization header.
   */
  async authenticate(request: IRequest): Promise<IPrincipal | null> {
    const authHeader = request.headers.get(this.header);
    if (!authHeader) {
      return null;
    }

    // Check for correct scheme
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== this.scheme) {
      return null;
    }

    const token = parts[1];
    if (!token) {
      return null;
    }

    try {
      const payload = await this.jwtService.verify<Record<string, unknown>>(token);

      // Map JWT claims to IPrincipal (conditionally include optional fields
      // via spread to satisfy exactOptionalPropertyTypes)
      const id = this.getStringClaim(payload, 'sub');
      const roles = this.getArrayClaim(payload, 'roles');
      const permissions = this.getArrayClaim(payload, 'permissions');
      const claims = this.buildClaims(payload);

      const principal: IPrincipal = {
        id,
        ...(roles ? { roles } : {}),
        ...(permissions ? { permissions } : {}),
        ...(claims ? { claims } : {}),
      };

      return principal;
    } catch {
      // Invalid token - return null (don't throw)
      return null;
    }
  }

  /**
   * Extract a string claim from payload.
   */
  private getStringClaim(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    return typeof value === 'string' ? value : 'unknown';
  }

  /**
   * Extract a string array claim from payload.
   */
  private getArrayClaim(
    payload: Record<string, unknown>,
    key: string,
  ): readonly string[] | undefined {
    const value = payload[key];
    if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) {
      return value;
    }
    return undefined;
  }

  /**
   * Build claims object from payload (excluding standard claims).
   */
  private buildClaims(payload: Record<string, unknown>): Record<string, unknown> | undefined {
    const standardClaims = ['sub', 'roles', 'permissions', 'iat', 'exp', 'nbf', 'aud', 'iss'];
    const claims: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(payload)) {
      if (!standardClaims.includes(key)) {
        claims[key] = value;
      }
    }

    return Object.keys(claims).length > 0 ? claims : undefined;
  }
}
