/**
 * CQRS plugin factory.
 *
 * @module
 */
import type {
  ICommandHandler,
  ICqrsFacade,
  IPipelineBehavior,
  IPlugin,
  IPluginContext,
  IQueryHandler,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY, resolveRegistryEntry } from '@setu-ts/common';
import type { CqrsPluginOptions } from '../interfaces/index.ts';
import { CommandBus } from '../bus/command-bus.ts';
import { QueryBus } from '../bus/query-bus.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Plugin name. */
const PLUGIN_NAME = 'cqrs-plugin';

/** Default options. */
const DEFAULT_OPTIONS: Required<CqrsPluginOptions> = {
  behaviors: [],
  commandHandlers: [],
  queryHandlers: [],
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
 * import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
 *
 * app.register(CqrsPlugin({
 *   behaviors: [timingBehavior],
 *   commandHandlers: [{ type: CREATE_USER, handler: new CreateUserHandler() }],
 *   queryHandlers: [{ type: GET_USER, handler: new GetUserHandler() }],
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function CqrsPlugin(options?: CqrsPluginOptions): IPlugin {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Split the two arms once, at plugin construction. Instances keep their
  // `register()` timing (byte-identical to the pre-factory behaviour);
  // factories are resolved at `onInit`, the first phase at which the registry
  // holds every capability — this plugin shares the NORMAL priority band with
  // the capabilities a factory may consume, where order is registration order.
  const commandInstances = opts.commandHandlers.filter(
    (entry): entry is { readonly type: string; readonly handler: ICommandHandler } =>
      typeof entry.handler !== 'function',
  );
  const commandFactories = opts.commandHandlers.filter(
    (
      entry,
    ): entry is { readonly type: string; readonly handler: RegistryFactory<ICommandHandler> } =>
      typeof entry.handler === 'function',
  );
  const queryInstances = opts.queryHandlers.filter(
    (entry): entry is { readonly type: string; readonly handler: IQueryHandler } =>
      typeof entry.handler !== 'function',
  );
  const queryFactories = opts.queryHandlers.filter(
    (entry): entry is { readonly type: string; readonly handler: RegistryFactory<IQueryHandler> } =>
      typeof entry.handler === 'function',
  );

  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    provides: [CAPABILITIES.CQRS, CAPABILITIES.COMMAND_BUS, CAPABILITIES.QUERY_BUS],
    priority: PLUGIN_PRIORITY.NORMAL,

    // deno-lint-ignore require-await
    async register(ctx: IPluginContext): Promise<void> {
      // Build buses with the configured behaviors. Instance behaviors are
      // passed to the constructors as today; factory behaviors are resolved at
      // onInit and the whole list replaced through setBehaviors.
      const instanceBehaviors = opts.behaviors.filter(
        (entry): entry is IPipelineBehavior => typeof entry !== 'function',
      );
      const commandBus = new CommandBus(instanceBehaviors);
      const queryBus = new QueryBus(instanceBehaviors);

      // Register the declaratively-supplied handler INSTANCES. Done here rather
      // than left to the application because the buses do not exist until this
      // point and `IApplication` exposes no lifecycle hook in which app code
      // could reach them.
      for (const entry of commandInstances) {
        commandBus.register(entry.type, entry.handler);
      }
      for (const entry of queryInstances) {
        queryBus.register(entry.type, entry.handler);
      }

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

      // At onInit: resolve the handler factories and the behavior list.
      // Handlers register under their entry's type; the behavior list is
      // resolved WHOLE, in declared order, and installed on both buses so a
      // mixed list runs in declared order rather than instances-then-factories.
      // A factory that throws rejects start(), naming the option and entry.
      ctx.lifecycle.onInit(() => {
        for (const [index, entry] of commandFactories.entries()) {
          const handler = resolveRegistryEntry(
            entry.handler,
            ctx.services,
            `CqrsPlugin({ commandHandlers })[${index}]`,
          );
          commandBus.register(entry.type, handler);
        }
        for (const [index, entry] of queryFactories.entries()) {
          const handler = resolveRegistryEntry(
            entry.handler,
            ctx.services,
            `CqrsPlugin({ queryHandlers })[${index}]`,
          );
          queryBus.register(entry.type, handler);
        }

        const behaviors = opts.behaviors.map((entry, index) =>
          resolveRegistryEntry(
            entry,
            ctx.services,
            `CqrsPlugin({ behaviors })[${index}]`,
          )
        );
        commandBus.setBehaviors(behaviors);
        queryBus.setBehaviors(behaviors);
      });

      // Register shutdown hook.
      // deno-lint-ignore require-await
      ctx.lifecycle.onClose(async () => {
        commandBus.clear();
        queryBus.clear();
      });
    },
  };
}
