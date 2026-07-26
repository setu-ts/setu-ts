import type { IPlugin, IPluginContext } from '@hono-enterprise/common';

/**
 * Options for {@linkcode createMockPlugin}.
 *
 * @since 0.1.0
 */
export interface MockPluginOptions {
  /** Plugin name (also used as the capability token when `provides` is absent). */
  name: string;
  /** The mock service object to register. */
  service: object;
  /**
   * Capability token this plugin provides. Defaults to `name`.
   * Override when the plugin name differs from the capability token.
   */
  provides?: string;
  /**
   * Registration priority; passed through to the kernel resolver.
   * Omitted when not needed (the returned plugin omits `priority` too).
   */
  priority?: number;
  /**
   * Additional registration callback invoked during `register(ctx)`.
   * Useful for registering middleware, routes, or lifecycle hooks
   * alongside the mock service.
   */
  register?: (ctx: IPluginContext) => void | Promise<void>;
}

/**
 * Creates an `IPlugin` that registers a mock service under a capability token.
 *
 * Collapses the boilerplate of writing a one-line plugin literal
 * (`{ name, provides: [...], register(ctx) { ctx.services.register(...) } }`)
 * into a single call. The plugin uses `options.name` as the default capability
 * token (overridable via `options.provides`).
 *
 * @example
 * ```typescript
 * import { createMockPlugin } from '@hono-enterprise/testing';
 * import { CAPABILITIES } from '@hono-enterprise/common';
 *
 * const mockDb = createMockPlugin({
 *   name: 'database',
 *   service: { query: () => [], connect: () => {} },
 * });
 *
 * // Consumed as ctx.services.get<Idb>(CAPABILITIES.DATABASE);
 * ```
 *
 * @param options - Mock plugin configuration
 * @returns An `IPlugin` that registers the mock service
 * @since 0.1.0
 */
export function createMockPlugin(options: MockPluginOptions): IPlugin {
  const provides = options.provides ?? options.name;
  const pluginParts: {
    name: string;
    version: string;
    provides: string[];
    register: (ctx: IPluginContext) => void | Promise<void>;
  } = {
    name: options.name,
    version: '0.1.0',
    provides: [provides],
    async register(ctx: IPluginContext): Promise<void> {
      ctx.services.register(provides, options.service);
      if (options.register) {
        await options.register(ctx);
      }
    },
  };

  if (options.priority !== undefined) {
    return { ...pluginParts, priority: options.priority };
  }

  return pluginParts as IPlugin;
}
