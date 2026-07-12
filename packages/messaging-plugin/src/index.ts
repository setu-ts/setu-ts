/**
 * @module
 *
 * Message broker plugin for cross-service integration events.
 *
 * Provides an `IMessageBroker` implementation with support for in-memory
 * and Redis Streams backends, plus an optional bridge from the in-process
 * event bus to external messaging.
 *
 * @example
 * ```typescript
 * import { MessagingPlugin, EventsMessagingBridge } from '@hono-enterprise/messaging-plugin';
 * import { CAPABILITIES } from '@hono-enterprise/common';
 *
 * // Register the messaging plugin with Redis Streams
 * app.register(MessagingPlugin({
 *   broker: 'redis-streams',
 *   url: 'redis://localhost:6379',
 * }));
 *
 * // Optionally bridge events to the broker
 * app.register(EventsMessagingBridge({
 *   eventTypes: ['user.created', 'user.updated'],
 * }));
 *
 * // Use the broker
 * const broker = app.ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
 * await broker.publish('test.topic', { data: 'value' });
 * ```
 *
 * @since 0.1.0
 */

// Plugin factories
export { MessagingPlugin } from './plugin/messaging-plugin.ts';
export { EventsMessagingBridge } from './bridge/events-messaging-bridge.ts';

// Broker implementations
export { InMemoryBroker } from './brokers/in-memory-broker.ts';
export { RedisStreamsBroker } from './brokers/redis-streams-broker.ts';

// Serializer
export { JsonSerializer } from './serializers/json-serializer.ts';
export type { ISerializer } from './serializers/serializer.ts';

// Option types
export type {
  EventsMessagingBridgeOptions,
  MessagingBrokerType,
  MessagingPluginOptions,
  RedisStreamsOptions,
} from './interfaces/index.ts';

// Re-export common messaging types (owned by @hono-enterprise/common)
export type {
  IMessageBroker,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  SubscribeOptions,
} from '@hono-enterprise/common';
