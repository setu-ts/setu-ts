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
 * Options accepted by {@linkcode IMessageBroker.request}.
 *
 * @since 0.1.0
 */
export interface RequestOptions {
  /**
   * Reply wait budget in milliseconds. When no correlated reply arrives within
   * this window, `request` rejects. Defaults to `5000` when omitted.
   */
  readonly timeoutMs?: number;
}

/**
 * Responder for a request topic. Its resolved value is sent back to the caller
 * as the reply, correlated to the originating request.
 *
 * @typeParam TReq - The request payload type
 * @typeParam TRes - The reply payload type
 * @param message - The deserialized request payload
 * @param metadata - Transport metadata for the request delivery
 * @since 0.1.0
 */
export type RequestHandler<TReq = unknown, TRes = unknown> = (
  message: TReq,
  metadata: MessageMetadata,
) => TRes | Promise<TRes>;

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
  /**
   * Sends a request to a topic and awaits a single correlated reply, providing
   * brokered request-reply (RPC) over the message broker.
   *
   * A responder registered with {@linkcode respond} on the same topic returns
   * the reply. The call rejects with a `RequestTimeoutError` when no reply
   * arrives within `options.timeoutMs`, and with a `RemoteHandlerError` when the
   * responder throws. Not every transport supports this: brokers that cannot
   * (e.g. Kafka's consumer-group model) throw a `MessagingNotSupportedError`.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic the responder is listening on
   * @param message - The request payload (serialized by the broker adapter)
   * @param options - Reply timeout behavior
   * @returns The reply payload
   */
  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes>;
  /**
   * Registers a responder for a request topic. The handler's resolved value is
   * sent back to the requesting caller, correlated to the originating request.
   *
   * Pass `options.queue` to load-balance requests across competing responders.
   * Brokers that do not support request-reply throw a `MessagingNotSupportedError`.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - The request topic to respond on
   * @param handler - Invoked per request; its result is returned to the caller
   * @param options - Consumer group behavior
   * @returns The active subscription
   */
  respond<TReq, TRes>(
    topic: string,
    handler: RequestHandler<TReq, TRes>,
    options?: SubscribeOptions,
  ): Promise<ISubscription>;
}
