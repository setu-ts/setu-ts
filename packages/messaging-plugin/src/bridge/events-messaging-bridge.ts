import type { IPlugin, IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { IDomainEvent, IEventBus } from '@hono-enterprise/common';
import type { IMessageBroker } from '@hono-enterprise/common';
import type { EventsMessagingBridgeOptions } from '../interfaces/index.ts';

/**
 * EventsMessagingBridge factory.
 *
 * Creates a plugin that forwards domain events from the in-process event bus
 * to an external messaging broker. This enables local events to be published
 * as cross-service messages without coupling the events and messaging plugins.
 *
 * The bridge is publish-only: it subscribes to configured event types on the
 * event bus and publishes them to the messaging broker.
 *
 * @param options - Bridge configuration options
 * @returns A configured IPlugin instance
 *
 * @example
 * ```typescript
 * app.register(EventsMessagingBridge({
 *   eventTypes: ['user.created', 'user.updated'],
 *   topicMapping: (eventType) => `events.${eventType}`,
 * }));
 * ```
 *
 * @since 0.1.0
 */
export function EventsMessagingBridge(
  options: EventsMessagingBridgeOptions,
): IPlugin {
  const { eventTypes, token, topicMapping, errorHandler } = options;

  return {
    name: 'events-messaging-bridge',
    version: '0.1.0',
    provides: [],
    optionalDependencies: ['events', 'messaging', 'logger'],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      // Resolve optional logger
      let logger: { error: (msg: string) => void } | undefined;
      if (ctx.services.has('logger')) {
        logger = ctx.services.get('logger');
      }

      // Resolve the event bus - throw if not available
      let bus: IEventBus;
      try {
        bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
      } catch {
        throw new Error(
          'EventsMessagingBridge requires the events capability to be registered. ' +
            'Ensure EventsPlugin is registered before this bridge.',
        );
      }

      // Resolve the messaging broker - throw if not available
      const brokerToken = token ?? CAPABILITIES.MESSAGING;
      let broker: IMessageBroker;
      try {
        broker = ctx.services.get<IMessageBroker>(brokerToken);
      } catch {
        throw new Error(
          `EventsMessagingBridge requires the messaging capability (${brokerToken}) to be registered. ` +
            'Ensure MessagingPlugin is registered before this bridge.',
        );
      }

      // Build effective error handler
      // Default: log via optional logger, then swallow
      const effectiveErrorHandler = errorHandler ??
        ((error: unknown, eventType: string) => {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger?.error(
            `EventsMessagingBridge failed to publish event "${eventType}": ${errorMsg}`,
          );
        });

      // Build topic mapping function
      const effectiveTopicMapping = topicMapping ?? ((type: string) => type);

      // Track subscriptions for cleanup
      const unsubscribeFns: Array<() => Promise<void>> = [];

      // Subscribe to each event type
      for (const eventType of eventTypes) {
        const unsub = bus.subscribe<IDomainEvent<unknown>>(eventType, async (event) => {
          try {
            const topic = effectiveTopicMapping(event.type);
            await broker.publish(topic, event.data);
          } catch (error) {
            effectiveErrorHandler(error, eventType);
          }
        });

        // Convert sync unsubscribe to async for consistency
        unsubscribeFns.push(async () => {
          await unsub();
        });
      }

      // Register close handler to unsubscribe
      ctx.lifecycle.onClose(async () => {
        for (const fn of unsubscribeFns) {
          await fn();
        }
      });
    },
  };
}
