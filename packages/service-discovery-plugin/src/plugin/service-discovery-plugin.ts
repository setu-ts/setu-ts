/**
 * `ServiceDiscoveryPlugin` — registers an {@linkcode IServiceDiscovery} under
 * `CAPABILITIES.SERVICE_DISCOVERY`.
 *
 * @module
 */
import type {
  HealthCheckResult,
  IPlugin,
  IPluginContext,
  IServiceDiscovery,
} from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { DiscoveryProvider, SelfRegistration } from '../interfaces/index.ts';
import type { ServiceDiscoveryPluginOptions } from '../options.ts';
import { resolveOptions } from '../options.ts';
import { createProvider } from '../providers/provider-factory.ts';
import { ServiceDiscoveryService } from '../services/service-discovery-service.ts';
import { SelfRegistrationNotSupportedError } from '../errors.ts';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'service-discovery-plugin';

/**
 * Creates the service discovery plugin.
 *
 * @example Static instances with failover from reported outcomes
 * ```typescript
 * app.register(ServiceDiscoveryPlugin({
 *   provider: 'static',
 *   services: {
 *     billing: [
 *       { host: '10.0.0.1', port: 8080 },
 *       { host: '10.0.0.2', port: 8080 },
 *     ],
 *   },
 * }));
 * ```
 * @example Consul, advertising this instance
 * ```typescript
 * app.register(ServiceDiscoveryPlugin({
 *   provider: 'consul',
 *   address: 'http://127.0.0.1:8500',
 *   selfRegistration: { serviceName: 'orders', address: '10.0.0.7', port: 3000 },
 * }));
 * ```
 * @param options - Provider arm and its configuration
 * @returns The plugin instance
 * @since 0.2.0
 */
export function ServiceDiscoveryPlugin(options: ServiceDiscoveryPluginOptions): IPlugin {
  // Resolved eagerly so a contradictory configuration fails at construction
  // rather than at the first resolve.
  const resolved = resolveOptions(options);

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    optionalDependencies: ['logger'],
    provides: [CAPABILITIES.SERVICE_DISCOVERY],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const provider = buildProvider(options, resolved, ctx);
      const registration = resolved.selfRegistration;

      if (registration !== undefined && typeof provider.registerSelf !== 'function') {
        throw new SelfRegistrationNotSupportedError(options.provider);
      }

      const service = new ServiceDiscoveryService(provider, ctx.runtime, resolved);
      ctx.services.register<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY, service);

      if (registration !== undefined) {
        // Bootstrap runs BEFORE listen(), so the instance is advertised a
        // moment before its socket is bound. That is safe only because the
        // mandatory health check keeps the backend reporting it critical, and
        // every read filters on passing instances.
        ctx.lifecycle.onBootstrap(async () => {
          await provider.registerSelf?.(registration);
        });

        // onStopping — NOT onShutdown — so the deregistration propagates while
        // the application is still serving normally. Deregistering after the
        // socket closes leaves callers routed at a dead port for up to one
        // check interval on every rolling deploy.
        ctx.lifecycle.onStopping(async () => {
          await deregister(provider, registration, ctx, resolved.selfRegistration?.drainDelayMs);
        });
      }

      ctx.health.register(
        'service-discovery',
        (): Promise<HealthCheckResult> =>
          Promise.resolve({
            // 'down' is unreachable by construction: with nothing cached and a
            // failing backend no resolve() ever succeeded, so the caller
            // already received a DiscoveryUnavailableError.
            status: service.degraded ? 'degraded' : 'up',
            data: {
              provider: service.providerKind,
              cachedServices: service.cachedServices,
              watchedServices: service.watchedServices,
              ejectedInstances: service.ejectedInstances,
              degraded: service.degraded,
            },
          }),
      );

      ctx.lifecycle.onClose(() => {
        service.close();
      });
    },
  };
}

/** Narrows the option union so each overload of `createProvider` is used. */
function buildProvider(
  options: ServiceDiscoveryPluginOptions,
  resolved: ReturnType<typeof resolveOptions>,
  ctx: IPluginContext,
): DiscoveryProvider {
  switch (options.provider) {
    case 'static':
      return createProvider(options, resolved, ctx.runtime);
    case 'consul':
      return createProvider(options, resolved, ctx.runtime);
    case 'kubernetes':
      return createProvider(options, resolved, ctx.runtime);
    case 'dns':
      return createProvider(options, resolved, ctx.runtime);
    default:
      return createProvider(options, resolved, ctx.runtime);
  }
}

/**
 * Deregisters, then holds the drain window open.
 *
 * Failures are logged and swallowed: rethrowing would turn a best-effort
 * cleanup into a failed `stop()`.
 */
async function deregister(
  provider: DiscoveryProvider,
  registration: SelfRegistration,
  ctx: IPluginContext,
  drainDelayMs: number | undefined,
): Promise<void> {
  try {
    await provider.deregisterSelf?.(registration);
  } catch (error) {
    ctx.logger?.warn('service-discovery: deregistration failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (drainDelayMs !== undefined && drainDelayMs > 0) {
    // Callers holding a stale instance list keep sending traffic for a moment
    // after the registry forgets this instance; this window serves them
    // normally instead of refusing them.
    await new Promise<void>((resolve) => {
      ctx.runtime.setTimeout(() => resolve(), drainDelayMs);
    });
  }
}
