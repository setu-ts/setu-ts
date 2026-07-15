/**
 * Refresh token service — issues, rotates, and revokes refresh tokens.
 *
 * @module
 */

import type { IJwtService, IPrincipal, IRuntimeServices } from '@hono-enterprise/common';
import { encodeBase64Url } from '../utils/base64url.ts';
import { parseDuration } from '../utils/duration.ts';
import type { RefreshTokenStore } from '../stores/refresh-token-store.ts';

/**
 * Options for constructing a RefreshTokenService.
 */
export interface RefreshTokenOptions {
  /** The JWT service used to sign/verify tokens. */
  readonly jwt: IJwtService;
  /** The store backing refresh tokens. */
  readonly store: RefreshTokenStore;
  /** Runtime services for random bytes and clock. */
  readonly runtime: IRuntimeServices;
  /** Optional access token options (passed through to jwt.sign). */
  readonly accessToken?: {
    readonly expiresIn?: string;
    readonly audience?: string;
    readonly issuer?: string;
  };
  /** Refresh token lifetime (default: '7d'). */
  readonly refreshTokenExpiresIn?: string;
}

/**
 * A pair of access + refresh tokens issued together.
 */
export interface TokenPair {
  /** Short-lived access token. */
  readonly accessToken: string;
  /** Refresh token (signed JWT with type:'refresh' and jti). */
  readonly refreshToken: string;
}

/**
 * Refresh token service implementing token rotation and revocation.
 *
 * This is NOT an IAuthStrategy and NOT an IAuthService method — it is an
 * app-instantiated service reached directly by the app's login/refresh/logout
 * route handlers.
 */
export class RefreshTokenService {
  private readonly jwt: IJwtService;
  private readonly store: RefreshTokenStore;
  private readonly runtime: IRuntimeServices;
  private readonly accessTokenOptions: {
    readonly expiresIn?: string;
    readonly audience?: string;
    readonly issuer?: string;
  } | undefined;
  private readonly refreshTokenExpiresIn: string;
  private readonly refreshTokenExpiresInMs: number;

  constructor(options: RefreshTokenOptions) {
    this.jwt = options.jwt;
    this.store = options.store;
    this.runtime = options.runtime;
    if (options.accessToken !== undefined) {
      this.accessTokenOptions = options.accessToken;
    }
    this.refreshTokenExpiresIn = options.refreshTokenExpiresIn ?? '7d';
    this.refreshTokenExpiresInMs = parseDuration(this.refreshTokenExpiresIn);
  }

  /**
   * Issue a new access + refresh token pair for the given principal.
   */
  async issue(principal: IPrincipal): Promise<TokenPair> {
    const jti = encodeBase64Url(this.runtime.randomBytes(16));
    const now = this.runtime.now();
    const expiresAt = now + this.refreshTokenExpiresInMs;

    // Mint access token
    const accessToken = await this.jwt.sign(
      {
        sub: principal.id,
        roles: principal.roles,
        permissions: principal.permissions,
        claims: principal.claims,
      },
      this.accessTokenOptions,
    );

    // Mint refresh token (type:'refresh' + jti) with the REFRESH lifetime,
    // carrying the configured audience/issuer so jwt.verify enforces them.
    const refreshOptions: {
      expiresIn: string;
      audience?: string;
      issuer?: string;
    } = {
      expiresIn: this.refreshTokenExpiresIn,
    };
    if (this.accessTokenOptions?.audience !== undefined) {
      refreshOptions.audience = this.accessTokenOptions.audience;
    }
    if (this.accessTokenOptions?.issuer !== undefined) {
      refreshOptions.issuer = this.accessTokenOptions.issuer;
    }
    const refreshToken = await this.jwt.sign(
      { sub: principal.id, type: 'refresh', jti },
      refreshOptions,
    );

    // Store the refresh token record
    await this.store.save({
      jti,
      principalId: principal.id,
      principal,
      expiresAt,
      revoked: false,
    });

    return { accessToken, refreshToken };
  }

  /**
   * Refresh a token pair: verify the refresh token, revoke its jti, and issue
   * a new pair (rotation). Returns null if the token is invalid, expired,
   * tampered with, not a refresh token, or already revoked (replay).
   */
  async refresh(refreshToken: string): Promise<TokenPair | null> {
    // Verify the refresh token JWT; verify() throws on an invalid, expired,
    // or tampered token — all of those mean "no new pair", never an error.
    let payload: { sub: string; type?: string; jti?: string };
    try {
      payload = await this.jwt.verify<{ sub: string; type?: string; jti?: string }>(
        refreshToken,
      );
    } catch {
      return null;
    }

    if (payload.type !== 'refresh' || payload.jti === undefined) {
      return null;
    }

    const record = await this.store.get(payload.jti);

    if (record === null || record.revoked) {
      // Token not found, expired, or replayed after rotation
      return null;
    }

    // Rotate: revoke the presented jti
    await this.store.revoke(payload.jti);

    // Issue a fresh pair from the stored principal snapshot
    return this.issue(record.principal);
  }

  /**
   * Revoke a refresh token (logout). Returns true if a live record was found
   * and revoked; false when the token does not verify or no live record
   * exists (missing, expired, or already revoked).
   */
  async revoke(refreshToken: string): Promise<boolean> {
    let payload: { jti?: string };
    try {
      payload = await this.jwt.verify<{ jti?: string }>(refreshToken);
    } catch {
      return false;
    }

    if (payload.jti === undefined) {
      return false;
    }

    const record = await this.store.get(payload.jti);
    if (record === null || record.revoked) {
      return false;
    }

    await this.store.revoke(payload.jti);
    return true;
  }
}
