/**
 * AuthPlugin factory that registers authentication and authorization services.
 *
 * @module
 */

import type { IPlugin, IPluginContext, IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IAuthStrategy, IPrincipal, ISessionService } from '@setu-ts/common';
import type { AuthPluginOptions } from '../interfaces/index.ts';
import { JwtService } from '../services/jwt-service.ts';
import { AuthService, LocalStrategy } from '../services/auth-service.ts';
import { RbacService } from '../services/rbac-service.ts';
import { JwtStrategy } from '../strategies/jwt-strategy.ts';
import { ApiKeyStrategy } from '../strategies/api-key-strategy.ts';
import { SessionStrategy } from '../strategies/session-strategy.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/**
 * AuthPlugin factory.
 *
 * Creates a plugin that registers:
 * - IJwtService under CAPABILITIES.JWT
 * - IAuthService under CAPABILITIES.AUTH
 * - IAuthorizationService under CAPABILITIES.AUTHORIZATION when `rbac` is configured
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
 * // Register the global middleware at the priority ARCHITECTURE.md §10
 * // reserves for it; a bare add() takes the kernel default of 500.
 * app.middleware.add(authMiddleware(), { priority: 300 });
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
    version: denoJson.version,
    provides: [
      CAPABILITIES.JWT,
      CAPABILITIES.AUTH,
      ...(options.rbac === undefined ? [] : [CAPABILITIES.AUTHORIZATION]),
    ],
    // The session strategy reads the session service, but only when
    // `options.session` is configured — the edge orders SessionPlugin before
    // AuthPlugin within the shared NORMAL priority band.
    optionalDependencies: [CAPABILITIES.SESSION],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
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
      const jwtStrategyOpts: {
        jwtService: JwtService;
        header?: string;
        scheme?: string;
      } = { jwtService };
      if (options.jwt.header !== undefined) {
        jwtStrategyOpts.header = options.jwt.header;
      }
      if (options.jwt.scheme !== undefined) {
        jwtStrategyOpts.scheme = options.jwt.scheme;
      }
      strategies.push(new JwtStrategy(jwtStrategyOpts));

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

      // Session strategy (optional). Fails at register() rather than per
      // request: the session service is resolved once, and a misconfiguration
      // (session arm without SessionPlugin) is a startup error, not a 401.
      if (options.session !== undefined) {
        if (!ctx.services.has(CAPABILITIES.SESSION)) {
          throw new Error(
            'auth-plugin: options.session requires the session capability — register the session-plugin (SessionPlugin), or drop options.session',
          );
        }
        const sessionService = ctx.services.get<ISessionService>(CAPABILITIES.SESSION);
        strategies.push(
          new SessionStrategy({ sessionService, toPrincipal: options.session.toPrincipal }),
        );
      }

      // Caller-supplied strategies, appended in declaration order after every
      // built-in (jwt → api-key → session → caller).
      if (options.strategies !== undefined) {
        for (const strategy of options.strategies) {
          strategies.push(strategy);
        }
      }

      // A strategy's name is its only identity; a duplicate makes the later
      // entry unreachable for anything that reasons about the chain by name.
      const seenNames = new Set<string>();
      for (const strategy of strategies) {
        if (seenNames.has(strategy.name)) {
          throw new Error(`auth-plugin: duplicate strategy name '${strategy.name}'`);
        }
        seenNames.add(strategy.name);
      }

      // Local strategy (optional, defaults to always-null). When no `local`
      // callback is configured, verifyCredentials resolves to null.
      const localStrategy = options.local
        ? new LocalStrategy(options.local.verify)
        : new LocalStrategy(() => Promise.resolve(null));

      // Create auth service
      const authService = new AuthService(strategies, localStrategy);

      // Register services
      ctx.services.register(CAPABILITIES.JWT, jwtService);
      ctx.services.register(CAPABILITIES.AUTH, authService);
      if (options.rbac !== undefined) {
        ctx.services.register(CAPABILITIES.AUTHORIZATION, new RbacService(options.rbac));
      }

      // Cleanup on close
      ctx.lifecycle.onClose(() => {
        // JwtService cached keys are GC'd when the service is dropped
      });
    },
  };
}
