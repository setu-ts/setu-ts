import type {
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { normalizeTransportHeaders, type TransportHeaderValue } from './header-normalize.ts';
import { createTopicInbox, type InternalSubscribeOptions, REPLY_INBOX_TRANSIENT } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { ReconnectSupervisor } from './reconnect.ts';
import type { IAmqpConnection, RabbitMqOptions } from '../interfaces/index.ts';
// amqplib's frame codec requires a Node Buffer for message content (it throws
// `TypeError('content is not a buffer')` for a string or a Uint8Array). This is
// the sanctioned cross-runtime static `node:` import (Deno/Node/Bun all support
// it); there is no web-standard value amqplib's wire protocol accepts.
import { Buffer } from 'node:buffer';

/**
 * Lazily load amqplib at runtime.
 *
 * @returns The amqplib module
 * @throws {Error} If the npm:amqplib package cannot be resolved
 */
async function loadAmqplib(): Promise<typeof import('npm:amqplib@0.10.x')> {
  const mod = await import('npm:amqplib@0.10.x');
  return mod;
}

/**
 * Structural validation for AMQP connection.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IAmqpConnection {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['createChannel', 'close'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the AMQP connection: prefer injected client, then lazy-load amqplib.
 *
 * @param url - RabbitMQ connection URL
 * @param injectedClient - Optionally injected AMQP connection
 * @returns The resolved connection
 * @throws {Error} If no client injected and amqplib cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient?: IAmqpConnection,
): Promise<IAmqpConnection> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected AMQP client does not match the required structural shape ' +
          '(needs: createChannel, close)',
      );
    }
    return injectedClient;
  }
  const amqplib = await loadAmqplib();
  const connection = await amqplib.connect(url);
  return connection as unknown as IAmqpConnection;
}

/**
 * Internal subscriber entry, kept as a *specification* (topic + handler +
 * queue) rather than a live channel handle. M70c: after a broker restart the
 * old channel is dead, so replay re-derives the consumer on the fresh
 * channel from this spec.
 */
interface ActiveConsumer {
  id: string;
  topic: string;
  handler: MessageHandler<unknown>;
  queue: string | undefined; // undefined means exclusive server-named queue
  /**
   * The `assertQueue` declaration this subscription's shape demands —
   * durable for a caller-supplied consumer-group queue, transient for a
   * private per-subscriber one. Carried on the spec so the drive-mode
   * replay re-asserts the SAME shape on the fresh channel (RabbitMQ 4
   * refuses a re-declaration that disagrees with the existing queue).
   */
  declareOptions: QueueDeclareOptions;
  consumerTag: string;
  channel: unknown;
}

/**
 * The two queue shapes this broker declares. RabbitMQ 4 refuses the previous
 * unconditional `{ durable: false }` for a DURABLE-adjacent named queue and
 * equally refuses `{ durable: true }` re-applied with different properties,
 * so the shape is computed once at subscribe time and reused verbatim.
 */
type QueueDeclareOptions =
  | { readonly durable: true }
  | { readonly exclusive: true; readonly autoDelete: true };

/**
 * RabbitMQ message broker implementation using AMQP 0-9-1 topic exchange.
 *
 * M70c: amqplib has no reconnect of any kind, so this broker runs the
 * {@linkcode ReconnectSupervisor} in **drive** mode — on a connection
 * `'error'`/`'close'` event it reconnects, re-asserts the exchange, and
 * replays every active subscription. `isReady()` keeps its lifecycle meaning
 * (a reconnecting broker is still ready); `reachability()` reports the
 * fault window, which the health indicator maps to `down`.
 *
 * @since 0.1.0
 */
export class RabbitMqBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #url: string;
  #injectedClient: IAmqpConnection | undefined;
  #exchangeName: string;
  #defaultQueue: string;
  #logger?: { error: (msg: string) => void };
  #connection: IAmqpConnection | null = null;
  #channel: unknown | null = null;
  #ready = false;
  #activeConsumers: Map<string, ActiveConsumer>;
  #rr: RequestReplyCore;
  #supervisor: ReconnectSupervisor;

  /**
   * Creates a new RabbitMQ broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   * @param options - RabbitMQ connection and configuration options
   */
  constructor(
    runtime: IRuntimeServices,
    serializer: ISerializer,
    options?: RabbitMqOptions,
  ) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#url = options?.url ?? 'amqp://localhost:5672';
    this.#injectedClient = options?.client;
    this.#exchangeName = options?.exchangeName ?? 'messaging';
    this.#defaultQueue = options?.defaultQueue ?? 'messaging-consumers';
    if (options?.logger) {
      this.#logger = options.logger;
    }
    this.#activeConsumers = new Map();
    this.#rr = new RequestReplyCore({
      publish: (topic, message, headers) => this.publishWithHeaders(topic, message, headers ?? {}),
      subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
      uuid: () => this.#runtime.uuid(),
      setTimeout: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => this.#runtime.clearTimeout(handle),
      openInbox: createTopicInbox({
        subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
        uuid: () => this.#runtime.uuid(),
      }),
    });
    this.#supervisor = new ReconnectSupervisor({
      runtime,
      mode: 'drive',
      reconnect: () => this.#reconnect(),
      reassert: () => this.#reassertExchange(),
      replay: () => this.#replayConsumers(),
      attachFaultListener: (onFault) => this.#attachFaultListeners(onFault),
    });
  }

  /**
   * Connects to RabbitMQ.
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    this.#connection = await resolveClient(this.#url, this.#injectedClient);
    this.#channel = await this.#createChannel();
    await this.#reassertExchange();
    this.#ready = true;
    this.#supervisor.start();
  }

  /**
   * Disconnects from RabbitMQ.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  async disconnect(): Promise<void> {
    this.#supervisor.stop();
    await this.#rr.close();
    // Close all active consumers
    for (const consumer of this.#activeConsumers.values()) {
      try {
        const realChannel = consumer.channel as unknown as { cancel(tag: string): Promise<void> };
        await realChannel.cancel(consumer.consumerTag);
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.#activeConsumers.clear();
    this.#channel = null;
    if (this.#connection && !this.#injectedClient) {
      try {
        await (this.#connection as unknown as { close(): Promise<void> }).close();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.#connection = null;
    this.#ready = false;
  }

  /**
   * Checks if the broker is connected (lifecycle — M70c).
   *
   * `true` while `connect()` has run and `disconnect()` has not, even during
   * a reconnect window: the lifecycle is intact, the backend is what is
   * down. Reachability is {@linkcode isHealthy}/{@linkcode reachability}.
   *
   * @returns `true` if connected, `false` otherwise
   * @since 0.1.0
   */
  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Tri-state backend reachability (M70c).
   *
   * `false` while the supervisor is in a fault window (the connection
   * dropped and the drive-mode reconnect has not yet succeeded); `true`
   * otherwise. This reads the fault flag directly — it is a zero-cost,
   * always-current value, so caching it (as the I/O probes do) would make the
   * signal stale exactly when it matters.
   *
   * @returns `true` when reachable, `false` when the broker is in a fault
   *   window
   * @since 0.1.0
   */
  reachability(): Promise<boolean> {
    return Promise.resolve(!this.#supervisor.faulted);
  }

  /**
   * Boolean port member (M70c): `false` only when positively unreachable.
   *
   * @returns `true` when reachable or unprobeable, `false` when the broker
   *   is in a fault window
   * @since 0.1.0
   */
  isHealthy(): Promise<boolean> {
    return Promise.resolve(!this.#supervisor.faulted);
  }

  /**
   * Publishes a message to a topic.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic to publish to
   * @param message - The message payload
   * @returns Resolves when published
   * @since 0.1.0
   */
  publish<T>(topic: string, message: T): Promise<void> {
    return this.publishWithHeaders(topic, message, {});
  }

  /** Publishes a message with framework-owned transport headers. @internal */
  async publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqBroker is not connected');
    }
    const serialized = this.#serializer.serialize(message);
    const realChannel = this.#channel as unknown as {
      assertExchange(exchange: string, type: string, options?: unknown): Promise<void>;
      publish(
        exchange: string,
        routingKey: string,
        content: Uint8Array,
        properties?: unknown,
      ): boolean;
    };

    // Assert topic exchange (idempotent)
    await realChannel.assertExchange(this.#exchangeName, 'topic', { durable: true });

    // Build properties
    const properties: Record<string, unknown> = {};
    properties.messageId = this.#runtime.uuid();
    properties.headers = headers;
    if (typeof message === 'object' && message !== null) {
      // Try to extract existing messageId/timestamp/headers if present
      const msg = message as Record<string, unknown>;
      if (typeof msg.messageId === 'string') {
        properties.messageId = msg.messageId;
      }
    }

    const content = Buffer.from(serialized, 'utf8');
    realChannel.publish(this.#exchangeName, topic, content, properties);
  }

  /**
   * Subscribes to a topic.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic to subscribe to
   * @param handler - The handler to invoke for each message
   * @param options - Optional subscription options (queue for consumer group)
   * @returns The subscription handle
   * @since 0.1.0
   */
  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    if (!this.#channel) {
      throw new Error('RabbitMqBroker is not connected');
    }

    // Determine queue name
    const queueName = options?.queue ?? `${this.#defaultQueue}-${this.#runtime.uuid()}`;
    const isExclusive = options?.queue === undefined;

    // X10-1: the declaration carries the intent the shape already encodes.
    // A caller-supplied queue name is a consumer GROUP — durable, so it
    // survives a broker restart, which is what `queue` documents. An absent
    // name (the private per-subscriber queue) is transient: exclusive +
    // autoDelete. RabbitMQ 4 refuses the old unconditional `{ durable: false
    // }` named non-exclusive form outright (`541 INTERNAL-ERROR …
    // transient_nonexcl_queues`).
    //
    // F3: the broker's own reply inbox is ALSO transient, but that is
    // decided by a marker on the INTERNAL subscribe call (the inbox marks
    // itself in `inbox.ts`), never by pattern-matching the queue NAME —
    // `SubscribeOptions.queue` has no reserved-prefix restriction, so a
    // legitimate consumer group named e.g. `rr.inbox.orders` must stay a
    // normal durable group queue.
    // The marker is package-internal (F3): it travels on the broker's own
    // `createTopicInbox` closure call and is never on the public surface, so
    // the public `SubscribeOptions` is narrowed here to read it.
    const declareOptions: QueueDeclareOptions = isExclusive ||
        (options as InternalSubscribeOptions | undefined)?.[REPLY_INBOX_TRANSIENT] === true
      ? { exclusive: true, autoDelete: true }
      : { durable: true };

    const subscriptionId = this.#runtime.uuid();
    const { consumerTag, channel } = await this.#consumeOn(
      queueName,
      topic,
      handler as MessageHandler<unknown>,
      declareOptions,
    );

    this.#activeConsumers.set(subscriptionId, {
      id: subscriptionId,
      topic,
      handler: handler as MessageHandler<unknown>,
      queue: isExclusive ? undefined : queueName,
      declareOptions,
      consumerTag,
      channel,
    });

    return {
      unsubscribe: async (): Promise<void> => {
        const consumer = this.#activeConsumers.get(subscriptionId);
        if (consumer) {
          try {
            const realCh = consumer.channel as unknown as { cancel(tag: string): Promise<void> };
            await realCh.cancel(consumer.consumerTag);
          } catch {
            // Ignore errors
          }
          this.#activeConsumers.delete(subscriptionId);
          // Delete exclusive queue on unsubscribe
          if (isExclusive && this.#channel) {
            try {
              const ch = this.#channel as unknown as { deleteQueue(queue: string): Promise<void> };
              await ch.deleteQueue(queueName);
            } catch {
              // Ignore errors
            }
          }
        }
      },
    };
  }

  /** Subscribes through the header-aware internal path. @internal */
  subscribeWithHeaders<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.subscribe(topic, handler, options);
  }

  /**
   * Sends a request and awaits a single correlated reply.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic a responder is listening on
   * @param message - The request payload
   * @param options - Reply timeout behavior
   * @returns The reply
   * @since 0.1.0
   */
  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes> {
    return this.requestWithHeaders(topic, message, {}, options);
  }

  /** Sends request-reply traffic with framework-owned headers. @internal */
  requestWithHeaders<TReq, TRes>(
    topic: string,
    message: TReq,
    headers: Readonly<Record<string, string>>,
    options?: RequestOptions,
  ): Promise<TRes> {
    return this.#rr.request<TRes>(topic, message, options, headers);
  }

  /**
   * Registers a responder whose result is returned to the requesting caller.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - The request topic to respond on
   * @param handler - Invoked per request; its result is returned to the caller
   * @param options - Consumer group behavior
   * @returns The active subscription
   * @since 0.1.0
   */
  respond<TReq, TRes>(
    topic: string,
    handler: RequestHandler<TReq, TRes>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.#rr.respond(
      topic,
      (message, metadata) => handler(message as TReq, metadata),
      options,
    );
  }

  /**
   * Creates a fresh channel on the current connection.
   */
  async #createChannel(): Promise<unknown> {
    const realConn = this.#connection as unknown as { createChannel(): Promise<unknown> };
    return await realConn.createChannel();
  }

  /**
   * Re-asserts the topic exchange on the current channel (idempotent).
   */
  async #reassertExchange(): Promise<void> {
    const realChannel = this.#channel as unknown as {
      assertExchange(exchange: string, type: string, options?: unknown): Promise<void>;
    };
    await realChannel.assertExchange(this.#exchangeName, 'topic', { durable: true });
  }

  /**
   * Establishes a consumer for a spec on the current channel, returning the
   * fresh tag and channel. Shared by {@linkcode subscribe} and the drive-mode
   * replay so both derive the consumer identically.
   */
  async #consumeOn(
    queueName: string,
    topic: string,
    handler: MessageHandler<unknown>,
    declareOptions: QueueDeclareOptions,
  ): Promise<{ consumerTag: string; channel: unknown }> {
    const realChannel = this.#channel as unknown as {
      assertExchange(exchange: string, type: string, options?: unknown): Promise<void>;
      assertQueue(queue: string, options?: unknown): Promise<{ queue: string }>;
      bindQueue(queue: string, source: string, pattern: string): Promise<void>;
      consume(
        queue: string,
        onMessage: (msg: unknown) => void,
        options?: unknown,
      ): Promise<{ consumerTag: string }>;
      ack(msg: unknown): void;
      nack(msg: unknown, allUpTo: boolean, requeue: boolean): void;
    };

    // Assert topic exchange
    await realChannel.assertExchange(this.#exchangeName, 'topic', { durable: true });

    // Assert queue and bind to topic — with the shape the subscription's
    // intent demands (X10-1), not a fixed one.
    await realChannel.assertQueue(queueName, declareOptions);
    await realChannel.bindQueue(queueName, this.#exchangeName, topic);

    const result = await realChannel.consume(
      queueName,
      async (msg) => {
        if (!msg) {
          return;
        }
        try {
          // Extract message properties
          const msgTyped = msg as { content?: unknown; properties?: Record<string, unknown> };
          const content = new TextDecoder().decode(msgTyped.content as Uint8Array);
          const deserialized = this.#serializer.deserialize<unknown>(content);

          const metadata: MessageMetadata = {
            topic,
            messageId: msgTyped.properties?.messageId as string ??
              this.#runtime.uuid(),
            timestamp: msgTyped.properties?.timestamp as Date ??
              new Date(this.#runtime.now()),
            headers: normalizeTransportHeaders(
              msgTyped.properties?.headers as
                | Readonly<Record<string, TransportHeaderValue>>
                | undefined,
            ),
          };

          await handler(deserialized, metadata);

          // Ack on success
          realChannel.ack(msg);
        } catch (error) {
          // Nack on failure without requeue
          realChannel.nack(msg, false, false);
          this.#logger?.error(`Message handler failed: ${error}`);
        }
      },
      { noAck: false },
    );

    return { consumerTag: result.consumerTag, channel: this.#channel };
  }

  /**
   * Drive-mode reconnect: re-establish the connection (when the broker owns
   * it) and a fresh channel.
   */
  async #reconnect(): Promise<void> {
    if (this.#injectedClient === undefined && this.#connection !== null) {
      try {
        await (this.#connection as unknown as { close(): Promise<void> }).close();
      } catch {
        // The old connection is already gone; ignore close failures
      }
      this.#connection = await resolveClient(this.#url, undefined);
    }
    this.#channel = await this.#createChannel();
  }

  /**
   * Drive-mode replay: re-subscribe every active consumer on the fresh
   * channel. This is why X2-1's queues showed no consumers after a broker
   * restart and never recovered — without it the subscriptions are lost.
   */
  async #replayConsumers(): Promise<void> {
    for (const consumer of [...this.#activeConsumers.values()]) {
      const queueName = consumer.queue ?? `${this.#defaultQueue}-${consumer.id}`;
      const { consumerTag, channel } = await this.#consumeOn(
        queueName,
        consumer.topic,
        consumer.handler,
        consumer.declareOptions,
      );
      consumer.consumerTag = consumerTag;
      consumer.channel = channel;
    }
  }

  /**
   * Attaches the `'error'`/`'close'` fault listeners to the current
   * connection and returns a disposer that removes them. A client without an
   * event surface (a minimal injected fake) returns a no-op disposer; the
   * fault window is then only observable through the probe, which still
   * reports the truth (no fault flag set).
   */
  #attachFaultListeners(onFault: () => void): () => void {
    const connection = this.#connection;
    if (connection === null || typeof connection.on !== 'function') {
      return () => {};
    }
    const listener = (err?: unknown): void => {
      void err;
      onFault();
    };
    connection.on('error', listener);
    connection.on('close', listener);
    return (): void => {
      if (typeof connection.off === 'function') {
        connection.off('error', listener);
        connection.off('close', listener);
      }
    };
  }
}
