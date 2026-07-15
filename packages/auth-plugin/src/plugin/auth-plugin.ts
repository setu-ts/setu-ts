/**
 * AuthPlugin factory that registers authentication and authorization services.
 *
 * @module
 */

import type { IPlugin, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { IAuthStrategy, IPrincipal } from '@hono-enterprise/common';
import type { AuthPluginOptions } from '../interfaces/index.ts';
import { JwtService } from '../services/jwt-service.ts';
import { AuthService, LocalStrategy } from '../services/auth-service.ts';
import { RbacService } from '../services/rbac-service.ts';
import { PasswordHasher } from '../services/password-hasher.ts';
import { JwtStrategy } from '../strategies/jwt-strategy.ts';
import { ApiKeyStrategy } from '../strategies/api-key-strategy.ts';

/**
 * AuthPlugin factory.
 *
 * Creates a plugin that registers:
 * - IJwtService under CAPABILITIES.JWT
 * - IAuthService under CAPABILITIES.AUTH
 * - IAuthorizationService under CAPABILITIES.AUTHORIZATION
 *
 * @param options - Plugin configuration options
 * @returns A configured IPlugin instance
 *
 * @example
 * ```typescript
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
 * ```
 */
export function AuthPlugin(options: AuthPluginOptions): IPlugin {
  // Validate options
  if (!options.jwt.secret && !(options.jwt.privateKey && options.jwt.publicKey)) {
    throw new Error(
      'AuthPlugin requires either jwt.secret (for HS256) or jwt.privateKey + jwt.publicKey (for RS256)',
    );
  }

  const algorithm = options.jwt.algorithm ?? (options.jwt.secret ? 'HS256' : 'RS256');

  return {
    name: 'auth-plugin',
    version: '0.1.0',
    provides: [CAPABILITIES.JWT, CAPABILITIES.AUTH, CAPABILITIES.AUTHORIZATION],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      // Resolve runtime
      const runtime = ctx.services.get<IRuntimeServices>('runtime');

      // Build JwtService options, assigning only defined values
      // (satisfies exactOptionalPropertyTypes)
      const jwtOptions: {
        secret?: string | Uint8Array;
        privateKey?: string;
        publicKey?: string;
        algorithm: 'HS256' | 'RS256';
        expectedAudience?: string;
        expectedIssuer?: string;
      } = {
        algorithm,
      };
      if (options.jwt.secret !== undefined) {
        jwtOptions.secret = options.jwt.secret;
      }
      if (options.jwt.privateKey !== undefined) {
        jwtOptions.privateKey = options.jwt.privateKey;
      }
      if (options.jwt.publicKey !== undefined) {
        jwtOptions.publicKey = options.jwt.publicKey;
      }
      if (options.jwt.audience !== undefined) {
        jwtOptions.expectedAudience = options.jwt.audience;
      }
      if (options.jwt.issuer !== undefined) {
        jwtOptions.expectedIssuer = options.jwt.issuer;
      }

      // Create JWT service
      const jwtService = new JwtService(runtime, jwtOptions);

      // Build strategies list
      const strategies: IAuthStrategy[] = [];

      // JWT strategy (always present)
      strategies.push(new JwtStrategy({ jwtService }));

      // API key strategy (optional)
      if (options.apiKey) {
        const apiKeyOpts: {
          header?: string;
          validate: (key: string) => Promise<IPrincipal | null>;
        } = { validate: options.apiKey.validate };
        if (options.apiKey.header !== undefined) {
          apiKeyOpts.header = options.apiKey.header;
        }
        strategies.push(new ApiKeyStrategy(apiKeyOpts));
      }

      // Local strategy (optional, defaults to always-null)
      const localStrategy = options.local
        ? new LocalStrategy(options.local.verify)
        : new LocalStrategy(async () => null);

      // Create auth service
      const authService = new AuthService(strategies, localStrategy);

      // Create RBAC service
      const rbacService = new RbacService(options.rbac);

      // Create password hasher (instantiated for app use via import)
      const _passwordHasher = new PasswordHasher(runtime);
      void _passwordHasher;

      // Register services
      ctx.services.register(CAPABILITIES.JWT, jwtService);
      ctx.services.register(CAPABILITIES.AUTH, authService);
      ctx.services.register(CAPABILITIES.AUTHORIZATION, rbacService);

      // Cleanup on close
      ctx.lifecycle.onClose(() => {
        // JwtService cached keys are GC'd when the service is dropped
      });
    },
  };
}
