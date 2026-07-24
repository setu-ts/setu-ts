import type {
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { RequestReplyCore } from './request-reply-core.ts';
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
 * Internal subscriber entry.
 */
interface ActiveConsumer {
  id: string;
  channel: unknown;
  consumerTag: string;
  queue: string | undefined; // undefined means exclusive server-named queue
}

/**
 * RabbitMQ message broker implementation using AMQP 0-9-1 topic exchange.
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
      publish: (topic, message) => this.publish(topic, message),
      subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
      uuid: () => this.#runtime.uuid(),
      setTimeout: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => this.#runtime.clearTimeout(handle),
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
    // Create channel unconditionally from the resolved connection
    const realConn = this.#connection as unknown as { createChannel(): Promise<unknown> };
    this.#channel = await realConn.createChannel();
    this.#ready = true;
  }

  /**
   * Disconnects from RabbitMQ.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  async disconnect(): Promise<void> {
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
   * Checks if the broker is connected.
   *
   * @returns `true` if connected, `false` otherwise
   * @since 0.1.0
   */
  isReady(): boolean {
    return this.#ready;
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
  async publish<T>(topic: string, message: T): Promise<void> {
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
      cancel(tag: string): Promise<void>;
    };

    // Assert topic exchange
    await realChannel.assertExchange(this.#exchangeName, 'topic', { durable: true });

    // Determine queue name
    const queueName = options?.queue ?? `${this.#defaultQueue}-${this.#runtime.uuid()}`;
    const isExclusive = options?.queue === undefined;

    // Assert queue and bind to topic
    await realChannel.assertQueue(queueName, { durable: false });
    await realChannel.bindQueue(queueName, this.#exchangeName, topic);

    // Consume messages
    const subscriptionId = this.#runtime.uuid();
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
          const deserialized = this.#serializer.deserialize<T>(content);

          const metadata: MessageMetadata = {
            topic,
            messageId: msgTyped.properties?.messageId as string ??
              this.#runtime.uuid(),
            timestamp: msgTyped.properties?.timestamp as Date ??
              new Date(this.#runtime.now()),
            headers: (msgTyped.properties?.headers as Readonly<Record<string, string>>) ??
              undefined,
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

    const activeConsumer: ActiveConsumer = {
      id: subscriptionId,
      channel: this.#channel!,
      consumerTag: result.consumerTag,
      queue: isExclusive ? undefined : queueName,
    };
    this.#activeConsumers.set(subscriptionId, activeConsumer);

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

  /**
   * Sends a request and awaits a single correlated reply.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic a responder is listening on
   * @param message - The request payload
   * @param options - Reply timeout behavior
   * @returns The reply payload
   * @since 0.1.0
   */
  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes> {
    return this.#rr.request<TRes>(topic, message, options);
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
}
