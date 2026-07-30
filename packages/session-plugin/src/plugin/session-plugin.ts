/**
 * The SessionPlugin factory.
 *
 * @module
 */
import type {
  HealthCheckResult,
  ICacheStore,
  IPlugin,
  IPluginContext,
  IRuntimeServices,
  ISessionService,
  ISessionStore,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { deriveKeyRing } from '../codec/crypto.ts';
import { csrfFormMiddleware } from '../middleware/csrf-form-middleware.ts';
import { sessionMiddleware } from '../middleware/session-middleware.ts';
import type { SessionPluginOptions } from '../options.ts';
import { resolveSessionConfig } from '../options.ts';
import { resolveSecrets } from '../secret/secret-resolver.ts';
import { SessionService } from '../services/session-service.ts';
import { CacheSessionStore } from '../stores/cache-session-store.ts';
import { MemorySessionStore } from '../stores/memory-session-store.ts';

/** Middleware priorities this plugin registers at. */
const MIDDLEWARE_PRIORITY = {
  /** After security headers (250), before authentication (300). */
  SESSION: 260,
  /** After the session loads and after the stateless CSRF check (270). */
  CSRF_FORM: 275,
} as const;

/**
 * Registers cookie-backed sessions under `CAPABILITIES.SESSION`, with optional
 * session-backed form CSRF.
 *
 * The default is a self-contained encrypted cookie: AES-256-GCM under a key
 * derived from the secret by HKDF-SHA256, all through `runtime.subtle`, so there
 * is no npm dependency and it works on Cloudflare Workers. Setting `store` moves
 * the payload server-side and leaves only an opaque id in the cookie, which is
 * what makes immediate revocation possible.
 *
 * @param options - Session configuration
 * @returns The plugin
 * @throws {SessionSecretMissingError} During `register()` when no adequate secret resolves
 * @throws {TypeError} During `register()` when a numeric option is not positive
 * @example
 * ```typescript
 * const app = createApplication({
 *   plugins: [
 *     RuntimePlugin(),
 *     SessionPlugin({ secret: process.env.SESSION_SECRET, csrf: {} }),
 *   ],
 * });
 * ```
 * @example
 * ```typescript
 * // Revocable sessions over whichever cache store is registered, with a
 * // rotation list: index 0 seals, both open.
 * SessionPlugin({
 *   secret: [newSecret, oldSecret],
 *   store: 'cache',
 *   mode: 'sign',
 *   rolling: true,
 * });
 * ```
 * @since 0.2.0
 */
export function SessionPlugin(options: SessionPluginOptions = {}): IPlugin {
  // Validated eagerly so a bad numeric option fails when the plugin is
  // constructed, not on the first request.
  const config = resolveSessionConfig(options);

  return {
    name: 'session-plugin',
    version: '0.1.0-alpha.3',
    dependencies: [CAPABILITIES.RUNTIME],
    // Ordered after these so the lookups below see them when present. Neither
    // is required: without secrets the env fallback applies, and the cache store
    // is only consulted when `store: 'cache'` asked for it.
    optionalDependencies: [CAPABILITIES.SECRETS, CAPABILITIES.CACHE],
    provides: [CAPABILITIES.SESSION],
    consumes: [CAPABILITIES.RUNTIME],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);

      const secrets = await resolveSecrets(options, {
        services: ctx.services,
        env: runtime.env,
      });

      // Derived once, here, so a runtime whose Web Crypto cannot do HKDF fails
      // at startup with a named error rather than per request.
      const ring = await deriveKeyRing(runtime.subtle, secrets, config.mode);

      const store = createStore(options.store, ctx, runtime);

      const service = new SessionService(config, ring, {
        subtle: runtime.subtle,
        randomBytes: (length) => runtime.randomBytes(length),
        now: () => runtime.now(),
        uuid: () => runtime.uuid(),
      }, store);

      ctx.services.register<ISessionService>(CAPABILITIES.SESSION, service);

      ctx.middleware.add(sessionMiddleware(service), {
        priority: MIDDLEWARE_PRIORITY.SESSION,
      });

      if (options.csrf !== undefined) {
        ctx.middleware.add(csrfFormMiddleware(options.csrf), {
          priority: MIDDLEWARE_PRIORITY.CSRF_FORM,
        });
      }

      ctx.health.register('session', async (): Promise<HealthCheckResult> => {
        const storeHealthy = await service.storeHealth();
        return {
          // A configured store that reports unhealthy is the one session
          // failure invisible from outside: cookies still arrive, but every
          // session reads as absent.
          status: storeHealthy === false ? 'down' : 'up',
          data: {
            strategy: service.strategy,
            mode: service.mode,
            keys: service.keyCount,
            store: storeHealthy ?? 'none',
          },
        };
      });

      ctx.lifecycle.onClose(async () => {
        await service.close();
      });
    },
  };
}

/**
 * Builds the configured store, resolving the cache capability for `'cache'`.
 *
 * @param store - The `store` option
 * @param ctx - The plugin context, for resolving the cache capability
 * @param runtime - Runtime services, for the memory store's clock and timers
 * @returns The store, or `undefined` for the cookie strategy
 * @throws {Error} If `'cache'` is requested but no cache capability is registered
 */
function createStore(
  store: SessionPluginOptions['store'],
  ctx: IPluginContext,
  runtime: IRuntimeServices,
): ISessionStore | undefined {
  if (store === undefined) {
    return undefined;
  }

  if (store === 'memory') {
    return new MemorySessionStore({
      now: () => runtime.now(),
      setInterval: (fn, ms) => runtime.setInterval(fn, ms),
      clearInterval: (handle) => runtime.clearInterval(handle),
    });
  }

  if (store === 'cache') {
    if (!ctx.services.has(CAPABILITIES.CACHE)) {
      throw new Error(
        "SessionPlugin({ store: 'cache' }) needs a cache provider, but no service is " +
          `registered under '${CAPABILITIES.CACHE}'. Register CachePlugin, or pass a store ` +
          'instance directly.',
      );
    }
    return new CacheSessionStore(ctx.services.get<ICacheStore>(CAPABILITIES.CACHE));
  }

  return store;
}
