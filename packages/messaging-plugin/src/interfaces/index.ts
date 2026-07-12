/**
 * Internal and option types for the messaging plugin.
 *
 * @module
 */

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
 * Broker type identifier.
 *
 * @since 0.1.0
 */
export type MessagingBrokerType = 'memory' | 'redis-streams';

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
  // deno-lint-ignore no-explicit-any
  serializer?: any;

  /**
   * Redis connection URL (used when broker is `'redis-streams'`).
   *
   * @defaultValue `'redis://localhost:6379'`
   */
  url?: string;

  /**
   * Injected Redis client (bypasses lazy ioredis import).
   */
  client?: IRedisStreamsClient;

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
