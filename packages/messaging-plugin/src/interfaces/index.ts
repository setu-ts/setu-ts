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
export type MessagingBrokerType = 'memory' | 'redis-streams' | 'rabbitmq' | 'nats' | 'kafka';

/**
 * Options for the MessagingPlugin factory.
 *
 * @since 0.1.0
 */
export interface MessagingPluginOptions {
  /**
   * The broker type to use.
   *
   * @defaultValue `'memory'`
   */
  broker?: MessagingBrokerType;

  /**
   * Instance name for multi-instance support.
   *
   * When provided, the plugin registers under a dot-namespaced token
   * (`messaging.<name>`) instead of the bare `'messaging'` token.
   *
   * @defaultValue `undefined` (uses bare `'messaging'` token)
   */
  name?: string;

  /**
   * Serializer for message payloads.
   *
   * @defaultValue `new JsonSerializer()`
   */
  serializer?: ISerializer;

  /**
   * Redis connection URL (used when broker is `'redis-streams'`).
   *
   * @defaultValue `'redis://localhost:6379'`
   */
  url?: string;

  /**
   * Injected client (bypasses lazy npm import).
   *
   * Supports Redis, RabbitMQ, NATS, or Kafka clients depending on the broker type.
   */
  client?: IRedisStreamsClient | IAmqpConnection | INatsConnection | IKafkaFactory;

  /**
   * Default consumer group name for Redis Streams subscriptions.
   *
   * @defaultValue `'messaging-consumers'`
   */
  defaultQueue?: string;

  /**
   * Poll interval in milliseconds for Redis Streams consumer loop.
   *
   * @defaultValue `100`
   */
  pollIntervalMs?: number;

  /**
   * Block timeout in milliseconds for Redis Streams XREADGROUP.
   *
   * @defaultValue `100`
   */
  blockSizeMs?: number;

  /**
   * RabbitMQ exchange name (used when broker is `'rabbitmq'`).
   *
   * @defaultValue `'messaging'`
   */
  exchangeName?: string;

  /**
   * NATS JetStream stream name (used when broker is `'nats'`).
   *
   * @defaultValue `'MESSAGING'`
   */
  streamName?: string;

  /**
   * Kafka bootstrap brokers (used when broker is `'kafka'`).
   *
   * @defaultValue `['localhost:9092']`
   */
  brokers?: readonly string[];

  /**
   * Kafka client ID (used when broker is `'kafka'`).
   *
   * @defaultValue `'messaging-client'`
   */
  clientId?: string;
}

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
