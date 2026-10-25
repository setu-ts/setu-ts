/**
 * DiPlugin — registers an optional dependency injection container under
 * `CAPABILITIES.DI_CONTAINER`.
 *
 * The service registry remains the primary resolution mechanism; this
 * container is a convenience layer for constructor injection and lifecycle
 * management. No other plugin depends on it.
 *
 * @module
 */
import type {
  IContainer,
  IPlugin,
  IPluginContext,
  IRuntimeServices,
  ServiceScope,
} from '@setu-ts/common';
import { CAPABILITIES, describeError, PLUGIN_PRIORITY, resolveProbeTiming } from '@setu-ts/common';

import { DiContainer } from '../container/container.ts';
import { tokenName } from '../container/errors.ts';
import { VERSION } from '../version.ts';

/**
 * Options for {@linkcode DiPlugin}.
 *
 * @since 0.1.0
 */
export interface DiPluginOptions {
  /**
   * Default lifecycle scope for providers registered without an explicit
   * scope. Defaults to `'singleton'`.
   */
  readonly defaultScope?: ServiceScope;
  /**
   * When `true`, resolving a token not registered in the container
   * automatically falls back to the kernel's ServiceRegistry. The first
   * successful fallback is cached as a singleton so subsequent resolves
   * are fast. Explicit DI registrations always take precedence. Defaults
   * to `true`, so a provider can inject a framework capability such as
   * `CAPABILITIES.LOGGER`; `false` confines resolution to the container's
   * own registrations.
   */
  readonly autoRegister?: boolean;
}

/** Default lifecycle scope when none is configured. */
const DEFAULT_SCOPE: ServiceScope = 'singleton';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'di-plugin';

/**
 * Creates the DiPlugin.
 *
 * The plugin registers an {@linkcode IContainer} under
 * `CAPABILITIES.DI_CONTAINER` at `PLUGIN_PRIORITY.NORMAL`. Other plugins
 * can then access it via `ctx.container` (lazily resolved by the kernel)
 * or `ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER)`.
 *
 * @example
 * ```typescript
 * import { DiPlugin } from '@setu-ts/di-plugin';
 *
 * app.register(DiPlugin({ defaultScope: 'singleton' }));
 * ```
 *
 * @param options - Plugin configuration
 *
 * @returns The plugin instance
 * @throws {Error} During bootstrap for invalid dependency graphs; on close for disposal failures
 *
 * @since 0.1.0
 */
export function DiPlugin(options?: DiPluginOptions): IPlugin {
  const defaultScope = options?.defaultScope ?? DEFAULT_SCOPE;
  const autoRegister = options?.autoRegister ?? true;

  return {
    name: PLUGIN_NAME,
    version: VERSION,
    provides: [CAPABILITIES.DI_CONTAINER],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const container = new DiContainer({
        defaultScope,
        autoRegister,
        reportDisposeError: (error: unknown): void => {
          ctx.logger?.warn('Request scope disposal failed', { error: describeError(error) });
        },
        // The runtime's timers when one is registered; otherwise disposal deadlines
        // fall back to withDeadline's own, so DiPlugin never requires a runtime.
        ...(ctx.services.has(CAPABILITIES.RUNTIME)
          ? { timing: resolveProbeTiming(ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME)) }
          : {}),
        ...(autoRegister
          ? {
              externalResolver: {
                has: (token: string): boolean => ctx.services.has(token),
                resolve: (token: string): unknown => ctx.services.get<object>(token),
              },
            }
          : {}),
      });
      ctx.services.register<IContainer>(CAPABILITIES.DI_CONTAINER, container);
      ctx.lifecycle.onBootstrap(() => {
        ctx.lifecycle.onBootstrap(() => {
          container.close();
          const opaque = container.opaqueTokens();
          if (opaque.length > 0) {
            ctx.logger?.debug('DI factories without inject are unchecked', {
              tokens: opaque.map(tokenName),
            });
          }
        });
      });
      ctx.lifecycle.onClose(() => container.dispose());
    },
  };
}
