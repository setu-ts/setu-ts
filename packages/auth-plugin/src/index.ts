/**
 * @module
 *
 * Authentication and authorization plugin for Hono Enterprise.
 *
 * Provides JWT and API key authentication, local credentials verification,
 * and RBAC authorization with role hierarchy.
 *
 * @example
 * ```typescript
 * import { AuthPlugin, authMiddleware, requireAuth, requireRole } from '@hono-enterprise/auth-plugin';
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
 * app.middleware.add(authMiddleware());
 * app.router.get('/protected', { middleware: [requireAuth()], handler });
 * ```
 */

// Re-export common types used by middleware
export type { IRequestContext } from '@hono-enterprise/common';

// Plugin factory
export { AuthPlugin } from './plugin/auth-plugin.ts';
export type { AuthPluginOptions } from './interfaces/index.ts';

// Option types
export type { JwtOptions } from './interfaces/index.ts';
export type { ApiKeyOptions } from './interfaces/index.ts';
export type { LocalOptions } from './interfaces/index.ts';

// Exported utilities
export { PasswordHasher } from './services/password-hasher.ts';

// Middleware
export { authMiddleware } from './middleware/auth-middleware.ts';
export { rateLimitMiddleware } from './middleware/rate-limit-middleware.ts';
export type { RateLimitOptions } from './middleware/rate-limit-middleware.ts';

// Guards
export { requireAuth } from './guards/index.ts';
export { requireRole } from './guards/index.ts';
export { requirePermission } from './guards/index.ts';
export { requireAnyRole } from './guards/index.ts';
export { requireAllPermissions } from './guards/index.ts';
export { publicRoute } from './guards/index.ts';

// Refresh token service
export { RefreshTokenService } from './services/refresh-token-service.ts';
export type { RefreshTokenOptions, TokenPair } from './services/refresh-token-service.ts';

// Refresh token store
export type { RefreshTokenRecord, RefreshTokenStore } from './stores/refresh-token-store.ts';
export { MemoryRefreshTokenStore } from './stores/refresh-token-store.ts';

// Rate limit store
export type { RateLimitResult, RateLimitStore } from './stores/rate-limit-store.ts';
export { MemoryRateLimitStore } from './stores/rate-limit-store.ts';
export { RedisRateLimitStore } from './stores/redis-rate-limit-store.ts';

// Re-export common contracts
export type {
  IAuthorizationService,
  IAuthService,
  IAuthStrategy,
  IJwtService,
  IPrincipal,
  JwtSignOptions,
  RbacConfig,
  RoleDefinition,
} from '@hono-enterprise/common';
