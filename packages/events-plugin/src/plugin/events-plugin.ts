/**
 * EventsPlugin — registers an `IEventBus` under `CAPABILITIES.EVENTS`.
 *
 * @module
 */
import type { IEventBus, ILogger, IPlugin, IPluginContext, RegistryFactory } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY, resolveRegistryEntry } from '@setu-ts/common';
import type { EventsPluginOptions } from '../interfaces/index.ts';
import { InMemoryEventBus } from '../bus/in-memory-event-bus.ts';
import { subscribeHandler } from '../handlers/event-handler.ts';
import type { IEventHandler } from '../handlers/event-handler.ts';
import type { EventDispatchOptions } from '../interfaces/index.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Plugin name. */
const PLUGIN_NAME = 'events-plugin';

/** Default dispatch options. */
const DEFAULT_OPTIONS: EventsPluginOptions = {
  async: false,
};

/**
 * Creates the EventsPlugin.
 *
 * Registers an `IEventBus` under `CAPABILITIES.EVENTS`. Single instance only
 * (no `name` option — adding one would be a dead option per CLAUDE.md).
 *
 * @example
 * ```typescript
 * import { EventsPlugin } from '@setu-ts/events-plugin';
 *
 * app.register(EventsPlugin({
 *   async: true,
 *   handlers: [
 *     { type: 'user-created', handler: new UserCreatedEventHandler() },
 *     { type: 'order-placed', handler: createOrderPlacedEventHandler },
 *   ],
 * }));
 * ```
 *
 * `handlers` accepts an instance or a `RegistryFactory`
 * (`(services: IServiceRegistry) => IEventHandler`). A factory is resolved at `onInit`
 * — the first phase at which the registry holds every capability — and subscribes
 * through the same `subscribeHandler` the instance arm uses. Instance handlers keep
 * their `register()` timing.
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function EventsPlugin(options?: EventsPluginOptions): IPlugin {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const handlers = opts.handlers ?? [];

  // Split the two arms once, at plugin construction. Instances keep their
  // `register()` timing (byte-identical to the pre-factory behaviour);
  // factories are resolved at `onInit`, the first phase at which the registry
  // holds every capability — this plugin shares the NORMAL priority band with
  // the capabilities a factory may consume, where order is registration order.
  const instances = handlers.filter(
    (entry): entry is { readonly type: string; readonly handler: IEventHandler<unknown> } =>
      typeof entry.handler !== 'function',
  );
  const factories = handlers.filter(
    (entry): entry is {
      readonly type: string;
      readonly handler: RegistryFactory<IEventHandler<unknown>>;
    } => typeof entry.handler === 'function',
  );

  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    optionalDependencies: ['logger'],
    provides: [CAPABILITIES.EVENTS],
    priority: PLUGIN_PRIORITY.NORMAL,

    // deno-lint-ignore require-await
    async register(ctx: IPluginContext): Promise<void> {
      // Resolve optional logger.
      const logger = ctx.services.has('logger') ? ctx.services.get<ILogger>('logger') : undefined;

      // Build default error handler if not provided.
      const defaultErrorHandler: (
        error: unknown,
        event: import('@setu-ts/common').IDomainEvent,
      ) => void = (error, event) => {
        if (logger) {
          logger.error('Event handler failed', { error, eventType: event.type });
        }
        // Silent no-op if no logger.
      };

      // Use custom errorHandler if provided, otherwise use default.
      const errorHandler = opts.errorHandler ?? defaultErrorHandler;

      // Build dispatch options.
      // Note: opts.async is always defined because DEFAULT_OPTIONS provides the default.
      const dispatchOptions: EventDispatchOptions = {
        async: opts.async as boolean,
        errorHandler,
      };

      // Create the bus.
      const bus = new InMemoryEventBus(dispatchOptions);

      // Register the bus under CAPABILITIES.EVENTS.
      ctx.services.register<IEventBus>(CAPABILITIES.EVENTS, bus);

      // Subscribe the declaratively-supplied handler INSTANCES, through the
      // SAME `subscribeHandler` a caller would use by hand — so the option and
      // the manual route cannot diverge. The `Unsubscribe` is dropped
      // deliberately: `onClose` clears the bus and no caller could hold the
      // handle.
      for (const entry of instances) {
        subscribeHandler(bus, entry.type, entry.handler);
      }

      // At onInit: resolve the handler factories and subscribe each result
      // through the SAME `subscribeHandler` the instance arm uses, so the two
      // arms cannot drift. A factory that throws rejects start(), naming the
      // option and the entry.
      ctx.lifecycle.onInit(() => {
        for (const [index, entry] of factories.entries()) {
          const handler = resolveRegistryEntry(
            entry.handler,
            ctx.services,
            `EventsPlugin({ handlers })[${index}]`,
          );
          subscribeHandler(bus, entry.type, handler);
        }
      });

      // Register health indicator.
      // deno-lint-ignore require-await
      ctx.health.register('events', async () => ({
        status: 'up' as const,
        data: { handlers: bus.subscriptionCount },
      }));

      // Register shutdown hook.
      // deno-lint-ignore require-await
      ctx.lifecycle.onClose(async () => {
        bus.clear();
      });
    },
  };
}
