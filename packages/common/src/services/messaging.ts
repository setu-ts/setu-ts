/**
 * Message broker contract, implemented by the MessagingPlugin's broker
 * adapters (RabbitMQ, NATS, Kafka, Redis Streams, in-memory) under
 * `CAPABILITIES.MESSAGING`.
 *
 * @module
 */

/**
 * Transport metadata accompanying a delivered message.
 *
 * @since 0.1.0
 */
export interface MessageMetadata {
  /** The topic the message arrived on. */
  readonly topic: string;
  /** Broker-assigned message ID, when available. */
  readonly messageId?: string;
  /** Delivery timestamp, when available. */
  readonly timestamp?: Date;
  /** Transport headers. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Handles messages delivered on a subscription.
 *
 * @typeParam T - The message payload type
 * @param message - The deserialized payload
 * @param metadata - Transport metadata
 * @since 0.1.0
 */
export type MessageHandler<T = unknown> = (
  message: T,
  metadata: MessageMetadata,
) => void | Promise<void>;

/**
 * Options accepted when subscribing to a topic.
 *
 * @since 0.1.0
 */
export interface SubscribeOptions {
  /** Consumer group / queue name for load-balanced delivery. */
  readonly queue?: string;
}

/**
 * An active subscription.
 *
 * @since 0.1.0
 */
export interface ISubscription {
  /**
   * Cancels the subscription.
   */
  unsubscribe(): Promise<void>;
}

/**
 * Message broker for cross-service integration events.
 *
 * @example
 * ```typescript
 * const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
 * await broker.publish('user.created', { userId: user.id });
 * ```
 * @since 0.1.0
 */
export interface IMessageBroker {
  /**
   * Opens the broker connection.
   */
  connect(): Promise<void>;
  /**
   * Closes the broker connection.
   */
  disconnect(): Promise<void>;
  /**
   * Publishes a message to a topic.
   *
   * @typeParam T - The payload type
   * @param topic - Destination topic
   * @param message - The payload (serialized by the broker adapter)
   */
  publish<T>(topic: string, message: T): Promise<void>;
  /**
   * Subscribes to a topic.
   *
   * @typeParam T - The payload type
   * @param topic - Source topic
   * @param handler - Invoked per delivered message
   * @param options - Consumer group behavior
   * @returns The active subscription
   */
  subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription>;
}
