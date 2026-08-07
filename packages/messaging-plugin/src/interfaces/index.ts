/**
 * Internal and option types for the messaging plugin.
 *
 * @module
 */

import type { ISerializer } from '../serializers/serializer.ts';

/**
 * Structural type for Redis Streams client.
 *
 * This type defines the minimal Redis client interface needed for stream operations.
 *
 * @since 0.1.0
 */
export interface IRedisStreamsClient {
  /** Add a message to a stream. */
  xadd(
    name: string,
    id: string,
    data: string | Array<string>,
    ...args: string[]
  ): Promise<string>;
  /** Create or manage consumer groups. */
  xgroup(
    command: 'CREATE' | 'DELETE' | 'SETID',
    ...args: string[]
  ): Promise<string | 'OK'>;
  /** Read messages from consumer groups. */
  xreadgroup(...args: string[]): Promise<unknown[][] | null>;
  /** Acknowledge processed messages. */
  xack(name: string, group: string, ...ids: string[]): Promise<number>;
  /** Quit/close the connection. */
  quit(): Promise<void>;
  /** Connect to the server (optional, for lazy clients). */
  connect?(): Promise<void>;
}

/**
 * Structural type for AMQP 0-9-1 connection (RabbitMQ).
 *
 * This type defines the minimal RabbitMQ client interface needed for topic exchange operations.
 *
 * @since 0.1.0
 */
export interface IAmqpConnection {
  /** Create a channel. */
  createChannel(): Promise<unknown>;
  /** Close the connection. */
  close(): Promise<void>;
}

/**
 * Structural type for NATS connection.
 *
 * This type defines the minimal NATS client interface needed for JetStream operations.
 *
 * @since 0.1.0
 */
export interface INatsConnection {
  /** Get JetStream instance. */
  jetstream(): unknown;
  /** Get JetStream manager (async). */
  jetstreamManager(): Promise<unknown>;
  /** Close the connection. */
  close(): void;
}

/**
 * Structural type for Kafka client factory.
 *
 * This type defines the minimal Kafka client interface needed for producer/consumer operations.
 *
 * @since 0.1.0
 */
export interface IKafkaFactory {
  /** Create a producer. */
  producer(): unknown;
  /** Create a consumer. */
  consumer(options: { groupId: string }): unknown;
}

/**
 * Broker type identifier.
 *
 * @since 0.1.0
 */
export type MessagingBrokerType =
  | 'memory'
  | 'redis-streams'
  | 'rabbitmq'
  | 'nats'
  | 'kafka'
  | 'pubsub'
  | 'service-bus'
  | 'custom';

/**
 * Shared options present on every {@linkcode MessagingPluginOptions} arm.
 *
 * @since 0.1.0
 */
export interface MessagingCommonOptions {
  /**
   * Instance name for multi-instance support.
   */
  name?: string;

  /**
   * Serializer for message payloads.
   */
  serializer?: ISerializer;
}

// ─── Arms of the discriminated union ───────────────────────────────────────────

/**
 * Default (memory) arm. The discriminant is optional so that `MessagingPlugin()`
 * and `MessagingPlugin({})` remain valid.
 *
 * @since 0.1.0
 */
export interface MemoryMessagingOptions extends MessagingCommonOptions {
  broker?: 'memory';
}

/**
 * Redis Streams arm.
 *
 * @since 0.1.0
 */
export interface RedisStreamsMessagingOptions extends MessagingCommonOptions {
  broker: 'redis-streams';
  url?: string;
  client?: IRedisStreamsClient;
  defaultQueue?: string;
  pollIntervalMs?: number;
  blockSizeMs?: number;
}

/**
 * RabbitMQ arm.
 *
 * @since 0.1.0
 */
export interface RabbitMqMessagingOptions extends MessagingCommonOptions {
  broker: 'rabbitmq';
  url?: string;
  client?: IAmqpConnection;
  exchangeName?: string;
  defaultQueue?: string;
}

/**
 * NATS arm.
 *
 * @since 0.1.0
 */
export interface NatsMessagingOptions extends MessagingCommonOptions {
  broker: 'nats';
  url?: string;
  client?: INatsConnection;
  streamName?: string;
  defaultQueue?: string;
}

/**
 * Kafka arm.
 *
 * @since 0.1.0
 */
export interface KafkaMessagingOptions extends MessagingCommonOptions {
  broker: 'kafka';
  brokers?: readonly string[];
  client?: IKafkaFactory;
  clientId?: string;
  defaultQueue?: string;
  replyTopic?: string;
}

/**
 * GCP Pub/Sub arm — injected transport variant.
 *
 * When {@link client} is provided, production credentials are not required.
 *
 * @since 0.1.0
 */
export interface PubSubMessagingOptionsInjected extends MessagingCommonOptions {
  broker: 'pubsub';
  /** Injected transport (bypasses lazy SDK load). Required for this arm. */
  client: import('../brokers/pubsub-broker.ts').IPubSubTransport;
  /** GCP project ID. Optional when {@link client} is injected. */
  projectId?: string;
  /** Service-account credentials. Optional when {@link client} is injected. */
  credentials?: unknown;
  defaultQueue?: string;
  replyTopic?: string;
}

/**
 * GCP Pub/Sub arm — production variant.
 *
 * Requires {@link projectId} and does NOT accept an injected {@link client}.
 *
 * @since 0.1.0
 */
export interface PubSubMessagingOptionsProduction extends MessagingCommonOptions {
  broker: 'pubsub';
  /** GCP project ID. Required for production. */
  projectId: string;
  /** Service-account credentials (object or key path). SDK ADC is used when omitted. */
  credentials?: unknown;
  /** Mutually exclusive with production arm — use {@link PubSubMessagingOptionsInjected} instead. */
  client?: never;
  defaultQueue?: string;
  replyTopic?: string;
}

/**
 * GCP Pub/Sub options — exclusive union of injected and production arms.
 *
 * @since 0.1.0
 */
export type PubSubMessagingOptions =
  | PubSubMessagingOptionsInjected
  | PubSubMessagingOptionsProduction;

/**
 * Azure Service Bus arm — injected transport variant.
 *
 * When {@link client} is provided, production credentials are not required.
 *
 * @since 0.1.0
 */
export interface ServiceBusMessagingOptionsInjected extends MessagingCommonOptions {
  broker: 'service-bus';
  /** Injected transport (bypasses lazy SDK load). Required for this arm. */
  client: import('../brokers/service-bus-broker.ts').IServiceBusTransport;
  /** Connection string. Optional when {@link client} is injected. */
  connectionString?: string;
  adminConnectionString?: string;
  defaultQueue?: string;
  replyTopic?: string;
}

/**
 * Azure Service Bus arm — production variant.
 *
 * Requires {@link connectionString} and does NOT accept an injected {@link client}.
 *
 * @since 0.1.0
 */
export interface ServiceBusMessagingOptionsProduction extends MessagingCommonOptions {
  broker: 'service-bus';
  /** Connection string for the Service Bus namespace. Required for production. */
  connectionString: string;
  /** Connection string for the administration client. Defaults to {@link connectionString}. */
  adminConnectionString?: string;
  /** Mutually exclusive with production arm — use {@link ServiceBusMessagingOptionsInjected} instead. */
  client?: never;
  defaultQueue?: string;
  replyTopic?: string;
}

/**
 * Azure Service Bus options — exclusive union of injected and production arms.
 *
 * @since 0.1.0
 */
export type ServiceBusMessagingOptions =
  | ServiceBusMessagingOptionsInjected
  | ServiceBusMessagingOptionsProduction;

/**
 * Custom (inject-any-broker) arm.
 *
 * @since 0.1.0
 */
export interface CustomMessagingOptions extends MessagingCommonOptions {
  broker: 'custom';
  instance: import('@setu-ts/common').IMessageBroker;
}

/**
 * Discriminated union of all broker option arms.
 *
 * The memory arm's `broker` is optional so that `{}` and `undefined` satisfy
 * the union, keeping the factory's own `= {}` default and every bare call
 * (`MessagingPlugin()`, `MessagingPlugin({})`) valid.
 *
 * @since 0.1.0
 */
export type MessagingPluginOptions =
  | MemoryMessagingOptions
  | RedisStreamsMessagingOptions
  | RabbitMqMessagingOptions
  | NatsMessagingOptions
  | KafkaMessagingOptions
  | PubSubMessagingOptions
  | ServiceBusMessagingOptions
  | CustomMessagingOptions;

/**
 * Redis-specific options (internal use).
 *
 * @since 0.1.0
 */
export interface RedisStreamsOptions {
  /** Redis connection URL. */
  url?: string;
  /** Injected Redis client. */
  client?: IRedisStreamsClient;
  /** Default consumer group name. */
  defaultQueue?: string;
  /** Poll interval in milliseconds. */
  pollIntervalMs?: number;
  /** Block timeout in milliseconds. */
  blockSizeMs?: number;
  /** Optional logger for error reporting. */
  logger?: { error: (msg: string) => void };
}

/**
 * RabbitMQ-specific options (internal use).
 *
 * @since 0.1.0
 */
export interface RabbitMqOptions {
  /** RabbitMQ connection URL. */
  url?: string;
  /** Injected AMQP connection. */
  client?: IAmqpConnection;
  /** Exchange name (default: 'messaging'). */
  exchangeName?: string;
  /** Default consumer group/queue name. */
  defaultQueue?: string;
  /** Optional logger for error reporting. */
  logger?: { error: (msg: string) => void };
}

/**
 * NATS-specific options (internal use).
 *
 * @since 0.1.0
 */
export interface NatsOptions {
  /** NATS connection URL(s). */
  url?: string;
  /** Injected NATS connection. */
  client?: INatsConnection;
  /** JetStream stream name (default: 'MESSAGING'). */
  streamName?: string;
  /** Default consumer group name. */
  defaultQueue?: string;
  /** Optional logger for error reporting. */
  logger?: { error: (msg: string) => void };
}

/**
 * Kafka-specific options (internal use).
 *
 * @since 0.1.0
 */
export interface KafkaOptions {
  /** Kafka bootstrap brokers. */
  brokers?: readonly string[];
  /** Injected Kafka factory. */
  client?: IKafkaFactory;
  /** Kafka client ID (default: 'messaging-client'). */
  clientId?: string;
  /** Default consumer group name. */
  defaultQueue?: string;
  /**
   * Topic every request-reply response is published to and read back from.
   *
   * Kafka topics are durable cluster resources and this broker creates none, so
   * the topic must already exist (or `auto.create.topics.enable` must be on).
   * Each broker instance reads it under its own consumer group, so every
   * instance sees every reply and discards those it did not originate — give a
   * high-traffic service its own reply topic to bound that fan-out.
   *
   * @defaultValue `'messaging.replies'`
   */
  replyTopic?: string;
  /** Optional logger for error reporting. */
  logger?: { error: (msg: string) => void };
}

/**
 * Options for the EventsMessagingBridge factory.
 *
 * @since 0.1.0
 */
export interface EventsMessagingBridgeOptions {
  /**
   * The event types to forward to the messaging broker.
   */
  eventTypes: readonly string[];

  /**
   * The capability token for the messaging broker to use.
   *
   * @defaultValue `CAPABILITIES.MESSAGING` (`'messaging'`)
   */
  token?: string;

  /**
   * Function to map event types to broker topics.
   *
   * @defaultValue Identity function (event type becomes topic)
   */
  topicMapping?: (eventType: string) => string;

  /**
   * Custom error handler for publish failures.
   *
   * @defaultValue Logs via optional logger, then swallows
   */
  errorHandler?: (error: unknown, eventType: string) => void;
}
