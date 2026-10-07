/**
 * Message broker contract, implemented by the MessagingPlugin's seven broker
 * adapters (in-memory, Redis Streams, RabbitMQ, NATS, Kafka, GCP Pub/Sub and
 * Azure Service Bus) under `CAPABILITIES.MESSAGING`.
 *
 * @module
 */

/**
 * Transport header carrying a publisher's ordering key on a broker with no
 * native ordering primitive. Every first-party broker writes it beside any
 * native mapping, so it is readable from {@linkcode MessageMetadata.headers}
 * regardless of the transport.
 *
 * @since 0.9.0
 */
export const ORDERING_KEY_HEADER = 'x-setu-ordering-key';

/**
 * Transport header carrying a publisher's de-duplication id on a broker with no
 * native de-duplication primitive.
 *
 * @since 0.9.0
 */
export const DEDUPLICATION_ID_HEADER = 'x-setu-deduplication-id';

/**
 * Options accepted by {@linkcode IMessageBroker.publish}.
 *
 * An option a broker has no native primitive for is carried as a transport
 * header, never dropped and never refused, so portable producer code behaves
 * the same on every broker and the option stays observable through
 * {@linkcode MessageMetadata.headers}.
 *
 * `orderingKey` decides **placement** — the same key reaches the same
 * partition, retry queue or ordered subscription where the broker has one — and
 * not the order handlers **finish** in. What a handler failure does to order
 * differs per broker; a consumer that needs order compares the delivered
 * envelope's version and drops or defers a stale message.
 *
 * Every value is validated on publish and refused by name when malformed; the
 * refused value is never echoed back. A delivered `x-setu-ordering-key` or
 * `x-setu-deduplication-id` header is a **hint written by whoever published the
 * message** — validation runs on the publish side only — so a consumer may use
 * it to order or de-duplicate its own work, never to authorize anything.
 *
 * @since 0.9.0
 */
export interface PublishOptions {
  /**
   * Key that places the message: Kafka's message key, Pub/Sub's `orderingKey`,
   * and {@linkcode ORDERING_KEY_HEADER} everywhere else. At most 128 UTF-8
   * bytes, no leading/trailing whitespace, no control characters. Derive it
   * from an aggregate the application owns — never from request input, which
   * would let a caller concentrate load on one partition or ordering key.
   */
  readonly orderingKey?: string;
  /**
   * Id a broker uses to drop a duplicate re-send: NATS's `Nats-Msg-Id`,
   * Service Bus's `messageId`, RabbitMQ's `messageId`, and
   * {@linkcode DEDUPLICATION_ID_HEADER} everywhere else. At most 128 UTF-8
   * bytes, no leading/trailing whitespace, no control characters. Derive it
   * from a producer-assigned id — a caller-chosen value lets the caller
   * suppress another message within the broker's de-duplication window.
   */
  readonly deduplicationId?: string;
  /**
   * Application headers written beside the framework's own. A name a transport
   * or its server acts on (including `traceparent`, `cc`, `bcc`, `payload`,
   * `nats-*`, `x-setu-*` and `goog`) is refused on every broker.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

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
  /**
   * Transport headers read from the delivered message. First-party brokers
   * populate this with `{}` when their transport carried no headers.
   */
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
   * @param options - Ordering, de-duplication and header options; an option the
   *   broker has no native primitive for is carried as a transport header
   */
  publish<T>(topic: string, message: T, options?: PublishOptions): Promise<void>;
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
   * responder throws.
   *
   * Request traffic rides a channel derived from `topic`, disjoint from plain
   * {@linkcode publish}/{@linkcode subscribe} on that same topic — a pub/sub
   * consumer never observes an RPC request, and vice versa.
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
  /**
   * Reports whether the broker's backend is reachable right now, for the
   * plugin's health indicator.
   *
   * Optional: a broker with no meaningful liveness check omits it, and the
   * indicator then reports only the lifecycle state (`isReady`).
   *
   * This answers a fact (reachability), not a policy: the indicator that
   * consumes it owns the `up`/`down` mapping.
   *
   * @returns `true` when the backend is reachable
   * @since 0.1.0
   */
  isHealthy?(): Promise<boolean>;
}
