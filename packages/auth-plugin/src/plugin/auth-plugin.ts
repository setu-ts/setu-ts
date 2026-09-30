/**
 * AuthPlugin factory that registers authentication and authorization services.
 *
 * @module
 */

import type {
  IAuthorizationDiagnosticsSource,
  IPlugin,
  IPluginContext,
  IRuntimeServices,
} from '@setu-ts/common';
import { CAPABILITIES, createPathMatcher, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IAuthStrategy, IPrincipal, ISessionService } from '@setu-ts/common';
import type { AuthPluginOptions } from '../interfaces/index.ts';
import { JwtService } from '../services/jwt-service.ts';
import { AuthService, LocalStrategy } from '../services/auth-service.ts';
import { RbacService } from '../services/rbac-service.ts';
import { JwtStrategy } from '../strategies/jwt-strategy.ts';
import { ApiKeyStrategy } from '../strategies/api-key-strategy.ts';
import { SessionStrategy } from '../strategies/session-strategy.ts';
import type { IAccessTokenRevocationStore } from '../stores/access-token-revocation-store.ts';
import { attachAuthorizationObserver } from '../diagnostics/authorization-observer.ts';
import { AuthPluginConfigurationError } from '../errors.ts';
import { authMiddleware } from '../middleware/auth-middleware.ts';
import {
  AuthorizationObservationCollector,
  compileAuthorizationDiagnosticsOptions,
  createDisabledAuthorizationSource,
  createUnsupportedAuthorizationSource,
} from '../diagnostics/authorization-observation-collector.ts';
import { compileIssuers } from '../issuers/trusted-issuer.ts';
import { IssuerKeySet } from '../issuers/key-set-cache.ts';
import { createDefaultAuthHttp } from '../issuers/auth-http.ts';
import { IssuerStrategy } from '../strategies/issuer-strategy.ts';
import { compileSignIn } from '../sign-in/config.ts';
import type { CompiledSignIn } from '../sign-in/config.ts';
import { registerSignInRoutes } from '../sign-in/routes.ts';
import { AuthSessionService } from '../sign-in/auth-session-service.ts';
import { AuthSessionStrategy } from '../strategies/auth-session-strategy.ts';
import denoJson from '../../deno.json' with { type: 'json' };

const AUTH_MIDDLEWARE_PRIORITY = 300;

/**
 * AuthPlugin factory.
 *
 * Creates a plugin that registers:
 * - IJwtService under CAPABILITIES.JWT when `jwt` is configured
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
 * // Passive authentication is registered globally at priority 300.
 * ```
 */
export function AuthPlugin(options: AuthPluginOptions): IPlugin {
  if (
    options.jwt !== undefined &&
    !options.jwt.secret &&
    !(options.jwt.privateKey && options.jwt.publicKey)
  ) {
    throw new Error(
      'AuthPlugin requires either jwt.secret (for HS256) or jwt.privateKey + jwt.publicKey (for RS256)',
    );
  }
  if (
    options.middleware !== undefined && options.middleware !== false &&
    options.middleware.priority !== undefined && !Number.isInteger(options.middleware.priority)
  ) {
    throw new AuthPluginConfigurationError(
      'auth-plugin: middleware.priority must be a finite integer',
    );
  }

  // Authorization decision explanations (M98h): the option is validated HERE,
  // at construction, whether or not RBAC is configured — a malformed option
  // refuses before any application exists rather than at `start()`, and is
  // never silently accepted by a JWT-only registration.
  const authorizationPolicy = options.authorizationDiagnostics === undefined
    ? null
    : compileAuthorizationDiagnosticsOptions(options.authorizationDiagnostics);

  // Outside issuers (M100b): validated here, at construction, because every
  // refusal is a configuration that would silently weaken verification.
  const compiledIssuers = options.issuers === undefined ? [] : compileIssuers(options.issuers);
  // Sign-in (M100c): validated HERE too, at construction, because every refusal
  // is a configuration that would otherwise fail at the provider — with an error
  // that names neither the option nor the route.
  const compiledSignIn: CompiledSignIn | null = options.signIn === undefined
    ? null
    : compileSignIn(options.signIn);
  if (options.http !== undefined && compiledIssuers.length === 0 && compiledSignIn === null) {
    throw new AuthPluginConfigurationError(
      'auth-plugin: http is only read for issuers and signIn; configure one or drop http',
    );
  }

  return {
    name: 'auth-plugin',
    version: denoJson.version,
    provides: [
      ...(options.jwt === undefined ? [] : [CAPABILITIES.JWT]),
      CAPABILITIES.AUTH,
      CAPABILITIES.AUTHORIZATION_DIAGNOSTICS,
      ...(options.rbac === undefined ? [] : [CAPABILITIES.AUTHORIZATION]),
      // M100c: one owner of "who is signed in", resolved by applications'
      // password logins and by every later federation milestone.
      ...(compiledSignIn === null ? [] : [CAPABILITIES.AUTH_SESSION]),
    ],
    // The session strategy reads the session service, but only when
    // `options.session` is configured — the edge orders SessionPlugin before
    // AuthPlugin within the shared NORMAL priority band.
    optionalDependencies: [CAPABILITIES.SESSION],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      // Resolve runtime
      const runtime = ctx.services.get<IRuntimeServices>('runtime');

      // The outbound seam is shared by the issuer key-set caches (M100b) and the
      // sign-in routes (M100c): one place to configure it, one place to fake it.
      const http = options.http ?? createDefaultAuthHttp();
      // Reporting is best-effort: a throwing logger must not abort a strategy
      // chain or a route handler whose outcome is already decided.
      const debug = (message: string): void => {
        try {
          ctx.logger?.debug(message);
        } catch {
          // Swallowed deliberately.
        }
      };

      // Build strategies list
      const strategies: IAuthStrategy[] = [];
      let jwtService: JwtService | null = null;

      if (options.jwt !== undefined) {
        const algorithm = options.jwt.algorithm ?? (options.jwt.secret ? 'HS256' : 'RS256');
        const jwtOptions: {
          secret?: string | Uint8Array;
          privateKey?: string;
          publicKey?: string;
          algorithm: 'HS256' | 'RS256';
          expectedAudience?: string;
          expectedIssuer?: string;
        } = { algorithm };
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

        jwtService = new JwtService(runtime, jwtOptions);
        const jwtStrategyOpts: {
          jwtService: JwtService;
          header?: string;
          scheme?: string;
          accessTokenRevocationStore?: IAccessTokenRevocationStore;
        } = { jwtService };
        if (options.jwt.header !== undefined) {
          jwtStrategyOpts.header = options.jwt.header;
        }
        if (options.jwt.scheme !== undefined) {
          jwtStrategyOpts.scheme = options.jwt.scheme;
        }
        if (options.jwt.accessTokenRevocationStore !== undefined) {
          jwtStrategyOpts.accessTokenRevocationStore = options.jwt.accessTokenRevocationStore;
        }
        strategies.push(new JwtStrategy(jwtStrategyOpts));
      }

      // Outside-issuer strategy (M100b), immediately after the JWT strategy and
      // reading the same header and scheme. The logger is read at call time.
      const issuerKeySets: IssuerKeySet[] = [];
      if (compiledIssuers.length > 0) {
        const bindings = compiledIssuers.map((issuer) => {
          const keySet = new IssuerKeySet(issuer, runtime, http, (name, reason) => {
            debug(`auth-plugin: issuer '${name}' key-set refresh failed (${reason})`);
          });
          issuerKeySets.push(keySet);
          return { issuer, keySet };
        });
        strategies.push(
          new IssuerStrategy({
            bindings,
            runtime,
            report: (name, reason) =>
              debug(`auth-plugin: issuer '${name}' token refused (${reason})`),
            ...(options.jwt?.header !== undefined ? { header: options.jwt.header } : {}),
            ...(options.jwt?.scheme !== undefined ? { scheme: options.jwt.scheme } : {}),
          }),
        );
        // Abort key-set fetches at the START of stop(): the kernel drains
        // in-flight requests before onClose, so a request parked on a fetch
        // would otherwise hold shutdown for up to fetchTimeoutMs. Cached sets
        // stay usable for requests still being served in this window.
        ctx.lifecycle.onStopping(() => {
          for (const keySet of issuerKeySets) {
            keySet.close();
          }
        });
        // Reads cached state only — no I/O — and never reports `down`, because
        // an identity-provider outage must not restart the application.
        ctx.health.register('auth', () => {
          const states: Record<string, string> = {};
          let current = true;
          compiledIssuers.forEach((issuer, index) => {
            const state = issuerKeySets[index].state();
            states[issuer.name] = state;
            current &&= state === 'current';
          });
          return Promise.resolve({
            status: current ? 'up' : 'degraded',
            data: { issuers: states },
          });
        });
      }

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

      // Sign-in with an outside provider (M100c). Registered after the M73
      // session strategy so a session carrying an explicit identity is consulted
      // before this plugin's own record, and before any caller-supplied strategy.
      const signInKeySets: IssuerKeySet[] = [];
      if (compiledSignIn !== null) {
        // The session is what holds the signed-in record and the pending state,
        // so this arm cannot work without it. Named as a startup error rather than
        // failing per request, exactly as options.session does.
        if (!ctx.services.has(CAPABILITIES.SESSION)) {
          throw new Error(
            'auth-plugin: options.signIn requires the session capability — register the session-plugin (SessionPlugin) alongside auth-plugin, or drop options.signIn',
          );
        }
        const sessionService = ctx.services.get<ISessionService>(CAPABILITIES.SESSION);

        // One key-set cache per oidc provider: it holds the discovery document the
        // routes read their endpoints from AND the keys the ID token verifies
        // against, so both come from the same issuer-checked fetch.
        const keySets = new Map<string, IssuerKeySet>();
        for (const provider of compiledSignIn.providers) {
          if (provider.compiledIssuer === undefined) {
            continue;
          }
          const keySet = new IssuerKeySet(
            provider.compiledIssuer,
            runtime,
            http,
            (name, reason) =>
              debug(`auth-plugin: signIn['${name}'] key-set refresh failed (${reason})`),
          );
          keySets.set(provider.name, keySet);
          signInKeySets.push(keySet);
        }

        const authSessionService = new AuthSessionService({
          sessionService,
          now: () => runtime.now(),
        });
        ctx.services.register(CAPABILITIES.AUTH_SESSION, authSessionService);

        strategies.push(
          new AuthSessionStrategy({
            sessionService,
            ...(compiledSignIn.refreshPrincipal === null
              ? {}
              : { refreshPrincipal: compiledSignIn.refreshPrincipal }),
          }),
        );

        registerSignInRoutes({
          router: ctx.router,
          config: compiledSignIn,
          sessionService,
          authSessionService,
          http,
          runtime,
          keySets,
          debug,
        });

        // Abort discovery fetches at the START of stop(), as the issuer key sets
        // do: the kernel drains in-flight requests before onClose, so a login
        // parked on a provider would otherwise hold shutdown open.
        ctx.lifecycle.onStopping(() => {
          for (const keySet of signInKeySets) {
            keySet.close();
          }
        });
      }

      // Caller-supplied strategies, appended in declaration order after every
      // built-in (jwt → api-key → session → auth-session → caller).
      if (options.strategies !== undefined) {
        for (const strategy of options.strategies) {
          strategies.push(strategy);
        }
      }

      if (strategies.length === 0) {
        throw new AuthPluginConfigurationError(
          'auth-plugin requires at least one passive authentication strategy; configure jwt, issuers, apiKey, session, or strategies',
        );
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
      if (jwtService !== null) {
        ctx.services.register(CAPABILITIES.JWT, jwtService);
      }
      ctx.services.register(CAPABILITIES.AUTH, authService);

      if (options.middleware !== false) {
        const configured = options.middleware ?? {};
        const isExcluded = createPathMatcher(configured.exclude ?? []);
        const authenticate = authMiddleware();
        ctx.middleware.add(
          async (requestContext, next): Promise<void> => {
            if (isExcluded(requestContext.request.path)) {
              await next();
              return;
            }
            await authenticate(requestContext, next);
          },
          {
            name: 'auth',
            priority: configured.priority ?? AUTH_MIDDLEWARE_PRIORITY,
          },
        );
      }

      // Authorization decision explanations (M98h). The AuthPlugin ALWAYS
      // registers a source under CAPABILITIES.AUTHORIZATION_DIAGNOSTICS: a
      // `disabled`-answering source without the option (whether or not RBAC
      // is configured — the owning plugin's answer that observation was never
      // opted into), an `unsupported` (`rbac-not-configured`) source when the
      // option is present but RBAC is absent, and an active collector when
      // both are present. The boolean IAuthorizationService remains
      // authoritative and unchanged; a diagnostic failure can never alter an
      // allow/deny or a guard's short-circuit order.
      const rbacService = options.rbac === undefined ? null : new RbacService(options.rbac);
      if (rbacService !== null) {
        ctx.services.register(CAPABILITIES.AUTHORIZATION, rbacService);
      }
      let authorizationSource: IAuthorizationDiagnosticsSource;
      if (authorizationPolicy === null) {
        authorizationSource = createDisabledAuthorizationSource();
      } else if (rbacService === null) {
        authorizationSource = createUnsupportedAuthorizationSource('rbac-not-configured');
      } else {
        const collector = new AuthorizationObservationCollector(
          authorizationPolicy,
          runtime,
          ctx.services,
          rbacService,
        );
        attachAuthorizationObserver(rbacService, collector);
        authorizationSource = collector;
      }
      ctx.services.register(
        CAPABILITIES.AUTHORIZATION_DIAGNOSTICS,
        authorizationSource,
      );

      // Cleanup on close
      ctx.lifecycle.onClose(() => {
        // JwtService cached keys are GC'd when the service is dropped. Key sets
        // are closed here too (idempotent) for a failed start, where the
        // stopping phase never runs.
        for (const keySet of issuerKeySets) {
          keySet.close();
        }
        for (const keySet of signInKeySets) {
          keySet.close();
        }
        if (authorizationSource instanceof AuthorizationObservationCollector) {
          authorizationSource.close();
        }
      });
    },
  };
}
