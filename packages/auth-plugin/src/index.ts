/**
 * @module
 *
 * Authentication and authorization plugin for Setu-TS.
 *
 * Provides JWT and API key authentication, local credentials verification,
 * and RBAC authorization with role hierarchy.
 *
 * @example
 * ```typescript
 * import { AuthPlugin, requireAuth, requireRole } from '@setu-ts/auth-plugin';
 *
 * app.register(AuthPlugin({
 *   jwt: { secret: process.env.JWT_SECRET! },
 *   rbac: {
 *     roles: {
 *       admin: { permissions: ['*'], inherits: ['user'] },
 *       user: { permissions: ['users:read'] },
 *     },
 *   },
 * }));
 * app.router.get('/protected', { middleware: [requireAuth()], handler });
 * ```
 */

// Plugin factory
export { AuthPlugin } from './plugin/auth-plugin.ts';
export type { AuthMiddlewareOption, AuthPluginOptions } from './interfaces/index.ts';
export { AuthPluginConfigurationError } from './errors.ts';

// Option types
export type { JwtOptions } from './interfaces/index.ts';
export type { ApiKeyOptions } from './interfaces/index.ts';
export type { LocalOptions } from './interfaces/index.ts';
export type { SessionAuthOptions } from './interfaces/index.ts';
export type { AuthorizationDiagnosticsOptions } from './interfaces/index.ts';
export type {
  IAuthHttp,
  IssuerAlgorithm,
  IssuerKeySource,
  TrustedIssuer,
} from './interfaces/index.ts';
export type {
  OAuth2Provider,
  OidcProvider,
  ProviderTokens,
  RefreshPrincipal,
  SignInConfig,
  SignInProvider,
  SignInProviderBase,
  TokenEndpointAuth,
} from './interfaces/index.ts';

// Exported utilities
export { MalformedPasswordHashError, PasswordHasher } from './services/password-hasher.ts';

// Middleware
export { authMiddleware } from './middleware/auth-middleware.ts';
export {
  DEFAULT_RATE_LIMIT_EXCLUDED_PATHS,
  defaultRateLimitKey,
  rateLimitMiddleware,
} from './middleware/rate-limit-middleware.ts';
export type { RateLimitOptions } from './middleware/rate-limit-middleware.ts';

// Guards
export { requireAuth } from './guards/index.ts';
export { requireRole } from './guards/index.ts';
export { requirePermission } from './guards/index.ts';
export { requireAnyRole } from './guards/index.ts';
export { requireAllPermissions } from './guards/index.ts';
export { requireMfa } from './guards/index.ts';
export { publicRoute } from './guards/index.ts';

// Refresh token service
export { RefreshTokenService } from './services/refresh-token-service.ts';
export type { RefreshTokenOptions, TokenPair } from './services/refresh-token-service.ts';

// Refresh token store
export type {
  IRefreshTokenRotation,
  RefreshTokenRecord,
  RefreshTokenStore,
} from './stores/refresh-token-store.ts';
export { MemoryRefreshTokenStore } from './stores/refresh-token-store.ts';

// Access-token revocation store
export type { IAccessTokenRevocationStore } from './stores/access-token-revocation-store.ts';
export { MemoryAccessTokenRevocationStore } from './stores/access-token-revocation-store.ts';

// Rate limit store
export type { RateLimitResult, RateLimitStore } from './stores/rate-limit-store.ts';
export { MemoryRateLimitStore } from './stores/rate-limit-store.ts';
export {
  DEFAULT_RATE_LIMIT_KEY_PREFIX,
  RedisRateLimitStore,
} from './stores/redis-rate-limit-store.ts';

// TOTP MFA (M100d)
export { TotpService } from './mfa/totp-service.ts';
export type {
  ConfirmEnrolmentResult,
  DisableResult,
  RecoveryCodesResult,
  RecoveryVerifyResult,
  TotpCompleteSignInResult,
  TotpProofResult,
  TotpServiceOptions,
  TotpVerifyResult,
} from './mfa/totp-service.ts';
export type { ITotpStore, ReserveAttemptResult, TotpEnrolment } from './stores/totp-store.ts';
export { MemoryTotpStore } from './stores/totp-store.ts';
export type { MfaOptions } from './interfaces/index.ts';

// Re-export common contracts
export type {
  IAuthorizationDiagnosticsSource,
  IAuthorizationService,
  IAuthService,
  IAuthStrategy,
  IJwtService,
  IPrincipal,
  JwtSignOptions,
  RbacConfig,
  RoleDefinition,
} from '@setu-ts/common';
