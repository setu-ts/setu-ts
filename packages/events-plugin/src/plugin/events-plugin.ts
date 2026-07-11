/**
 * EventsPlugin — registers an `IEventBus` under `CAPABILITIES.EVENTS`.
 *
 * @module
 */
import type { IEventBus, ILogger, IPlugin, IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { EventsPluginOptions } from '../interfaces/index.ts';
import { InMemoryEventBus } from '../bus/in-memory-event-bus.ts';
import type { EventDispatchOptions } from '../interfaces/index.ts';

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
 * import { EventsPlugin } from '@hono-enterprise/events-plugin';
 *
 * app.register(EventsPlugin({ async: true }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function EventsPlugin(options?: EventsPluginOptions): IPlugin {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
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
        event: import('@hono-enterprise/common').IDomainEvent,
      ) => void = (error, event) => {
        if (logger) {
          logger.error('Event handler failed', { error, eventType: event.type });
        }
        // Silent no-op if no logger.
      };

      // Use custom errorHandler if provided, otherwise use default.
      const errorHandler = opts.errorHandler ?? defaultErrorHandler;

      // Build dispatch options.
      const dispatchOptions: EventDispatchOptions = {
        async: opts.async ?? false,
        errorHandler,
      };

      // Create the bus.
      const bus = new InMemoryEventBus(dispatchOptions);

      // Register the bus under CAPABILITIES.EVENTS.
      ctx.services.register<IEventBus>(CAPABILITIES.EVENTS, bus);

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
