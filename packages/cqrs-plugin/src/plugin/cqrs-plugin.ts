/**
 * CQRS plugin factory.
 *
 * @module
 */
import type { ICqrsFacade, IPlugin, IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { CqrsPluginOptions } from '../interfaces/index.ts';
import { CommandBus } from '../bus/command-bus.ts';
import { QueryBus } from '../bus/query-bus.ts';

/** Plugin name. */
const PLUGIN_NAME = 'cqrs-plugin';

/** Default options. */
const DEFAULT_OPTIONS: Required<CqrsPluginOptions> = {
  behaviors: [],
};

/**
 * Creates the CQRS plugin.
 *
 * Registers three services:
 * - `ICommandBus` under `CAPABILITIES.COMMAND_BUS`
 * - `IQueryBus` under `CAPABILITIES.QUERY_BUS`
 * - `ICqrsFacade` under `CAPABILITIES.CQRS`
 *
 * Single instance only — registering a second `CqrsPlugin()` throws (duplicate
 * capability provider, per kernel behavior).
 *
 * @example
 * ```typescript
 * import { CqrsPlugin } from '@hono-enterprise/cqrs-plugin';
 *
 * app.register(CqrsPlugin({ behaviors: [timingBehavior] }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function CqrsPlugin(options?: CqrsPluginOptions): IPlugin {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    provides: [CAPABILITIES.CQRS, CAPABILITIES.COMMAND_BUS, CAPABILITIES.QUERY_BUS],
    priority: PLUGIN_PRIORITY.NORMAL,

    // deno-lint-ignore require-await
    async register(ctx: IPluginContext): Promise<void> {
      // Build buses with the configured behaviors.
      const commandBus = new CommandBus(opts.behaviors);
      const queryBus = new QueryBus(opts.behaviors);

      // Build the facade.
      const facade: ICqrsFacade = {
        commandBus,
        queryBus,
      };

      // Register services.
      ctx.services.register(CAPABILITIES.COMMAND_BUS, commandBus);
      ctx.services.register(CAPABILITIES.QUERY_BUS, queryBus);
      ctx.services.register(CAPABILITIES.CQRS, facade);

      // Register health indicator.
      // deno-lint-ignore require-await
      ctx.health.register('cqrs', async () => ({
        status: 'up' as const,
        data: {
          commands: commandBus.handlerCount,
          queries: queryBus.handlerCount,
        },
      }));

      // Register shutdown hook.
      // deno-lint-ignore require-await
      ctx.lifecycle.onClose(async () => {
        commandBus.clear();
        queryBus.clear();
      });
    },
  };
}
