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
import type { IContainer, IPlugin, IPluginContext, ServiceScope } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { ContainerBuilder } from '../container/container-builder.ts';
import type { ExternalResolver } from '../container/container.ts';

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
   * to `false`.
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
 * import { DiPlugin } from '@hono-enterprise/di-plugin';
 *
 * app.register(DiPlugin({
 *   defaultScope: 'singleton',
 *   autoRegister: true,
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function DiPlugin(options?: DiPluginOptions): IPlugin {
  const defaultScope = options?.defaultScope ?? DEFAULT_SCOPE;
  const autoRegister = options?.autoRegister ?? false;

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    provides: [CAPABILITIES.DI_CONTAINER],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const builder = new ContainerBuilder()
        .setDefaultScope(defaultScope)
        .setAutoRegister(autoRegister);

      if (autoRegister) {
        const resolver: ExternalResolver = {
          has: (token: string): boolean => ctx.services.has(token),
          resolve: (token: string): unknown => ctx.services.get<object>(token),
        };
        builder.setExternalResolver(resolver);
      }

      const container = builder.build();
      ctx.services.register<IContainer>(CAPABILITIES.DI_CONTAINER, container);
    },
  };
}
