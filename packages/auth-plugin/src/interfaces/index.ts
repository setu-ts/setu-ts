/**
 * Auth plugin configuration types.
 *
 * @module
 */

import type { IPrincipal, RbacConfig } from '@hono-enterprise/common';

/**
 * JWT configuration options.
 *
 * @since 0.1.0
 */
export interface JwtOptions {
  /** Secret key for HS256 algorithm. Required if RS256 keys not provided. */
  readonly secret?: string | Uint8Array;
  /** Private key for RS256 signing (PEM format). Required if HS256 secret not provided. */
  readonly privateKey?: string;
  /** Public key for RS256 verification (PEM format). Required for RS256 verification. */
  readonly publicKey?: string;
  /** Algorithm to use. Inferred from key material if omitted. */
  readonly algorithm?: 'HS256' | 'RS256';
  /** Expected audience for verification. */
  readonly audience?: string;
  /** Expected issuer for verification. */
  readonly issuer?: string;
  /** Header name for token extraction (default: 'authorization'). */
  readonly header?: string;
  /** Token scheme prefix (default: 'bearer'). */
  readonly scheme?: string;
}

/**
 * API key configuration options.
 *
 * @since 0.1.0
 */
export interface ApiKeyOptions {
  /** Header name for API key (default: 'X-API-Key'). */
  readonly header?: string;
  /**
   * Callback to validate the API key and return a principal.
   * Return `null` if the key is invalid.
   */
  readonly validate: (key: string) => Promise<IPrincipal | null>;
}

/**
 * Local (credentials) configuration options.
 *
 * @since 0.1.0
 */
export interface LocalOptions {
  /**
   * Callback to verify credentials (e.g., username/password).
   * Return `null` if credentials are invalid.
   */
  readonly verify: (identifier: string, secret: string) => Promise<IPrincipal | null>;
}

/**
 * Auth plugin configuration options.
 *
 * @since 0.1.0
 */
export interface AuthPluginOptions {
  /** JWT configuration. Required. */
  readonly jwt: JwtOptions;
  /** API key configuration. Optional. */
  readonly apiKey?: ApiKeyOptions;
  /** Local credentials configuration. Optional. */
  readonly local?: LocalOptions;
  /** RBAC configuration. Required for authorization guards. */
  readonly rbac: RbacConfig;
}
