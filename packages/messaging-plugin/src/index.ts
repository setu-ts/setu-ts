/**
 * @module
 *
 * Message broker plugin for cross-service integration events.
 *
 * Provides an `IMessageBroker` implementation with support for in-memory,
 * Redis Streams, RabbitMQ, NATS (JetStream), Kafka, GCP Pub/Sub, Azure
 * Service Bus, and custom-injected backends, plus an optional bridge from
 * the in-process event bus to external messaging.
 *
 * @example
 * ```typescript
 * import { MessagingPlugin } from '@hono-enterprise/messaging-plugin';
 * import { CAPABILITIES } from '@hono-enterprise/common';
 *
 * // GCP Pub/Sub
 * app.register(MessagingPlugin({
 *   broker: 'pubsub',
 *   projectId: 'my-project',
 * }));
 *
 * // Azure Service Bus
 * app.register(MessagingPlugin({
 *   broker: 'service-bus',
 *   connectionString: 'Endpoint=sb://...',
 * }));
 *
 * // Custom broker
 * app.register(MessagingPlugin({
 *   broker: 'custom',
 *   instance: myBroker,
 * }));
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
export { RabbitMqBroker } from './brokers/rabbitmq-broker.ts';
export { NatsBroker } from './brokers/nats-broker.ts';
export { KafkaBroker } from './brokers/kafka-broker.ts';
export { GcpPubSubBroker } from './brokers/pubsub-broker.ts';
export { ServiceBusBroker } from './brokers/service-bus-broker.ts';

// Adapter / load helpers
export { adaptPubSubModule, loadPubSubModule } from './brokers/pubsub-broker.ts';
export { adaptServiceBusModule, loadServiceBusModule } from './brokers/service-bus-broker.ts';

// Serializer
export { JsonSerializer } from './serializers/json-serializer.ts';
export type { ISerializer } from './serializers/serializer.ts';

// Request-reply error classes (for consumer `instanceof` handling)
export {
  CloudBrokerUnavailableError,
  MessagingNotSupportedError,
  RemoteHandlerError,
  ReplyInboxUnavailableError,
  RequestTimeoutError,
} from './errors.ts';

// Option types
export type {
  CustomMessagingOptions,
  EventsMessagingBridgeOptions,
  KafkaMessagingOptions,
  KafkaOptions,
  MemoryMessagingOptions,
  MessagingBrokerType,
  MessagingCommonOptions,
  MessagingPluginOptions,
  NatsMessagingOptions,
  NatsOptions,
  RabbitMqMessagingOptions,
  RabbitMqOptions,
  RedisStreamsMessagingOptions,
  RedisStreamsOptions,
  ServiceBusMessagingOptions,
} from './interfaces/index.ts';

// Port types
export type { IPubSubSubscription, IPubSubTransport } from './brokers/pubsub-broker.ts';
export type {
  IServiceBusSubscription,
  IServiceBusTransport,
} from './brokers/service-bus-broker.ts';

// Re-export common messaging types (owned by @hono-enterprise/common)
export type {
  IMessageBroker,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@hono-enterprise/common';
