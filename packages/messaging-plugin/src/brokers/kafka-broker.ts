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
import type { ReplyInbox } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import type { IKafkaFactory, KafkaOptions } from '../interfaces/index.ts';

/** Reply topic used when {@link KafkaOptions.replyTopic} is omitted. */
const DEFAULT_REPLY_TOPIC = 'messaging.replies';

/**
 * Consumer-group prefix for reply inboxes. Each broker instance derives a
 * unique group from it so replies are delivered to every instance rather than
 * load-balanced across the shared default group.
 */
const REPLY_GROUP_PREFIX = 'rr-inbox-';

/**
 * Lazily load kafkajs at runtime.
 *
 * @returns The kafkajs module
 * @throws {Error} If the npm:kafkajs package cannot be resolved
 */
async function loadKafkajs(): Promise<typeof import('npm:kafkajs@2.x')> {
  const mod = await import('npm:kafkajs@2.x');
  return mod;
}

/**
 * Structural validation for Kafka factory.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IKafkaFactory {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['producer', 'consumer'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the Kafka factory: prefer injected client, then lazy-load kafkajs.
 *
 * @param brokers - Kafka bootstrap brokers
 * @param clientId - Kafka client ID
 * @param injectedClient - Optionally injected Kafka factory
 * @returns The resolved factory
 * @throws {Error} If no client injected and kafkajs cannot be loaded
 */
async function resolveClient(
  brokers: readonly string[],
  clientId: string,
  injectedClient?: IKafkaFactory,
): Promise<IKafkaFactory> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected Kafka client does not match the required structural shape ' +
          '(needs: producer, consumer)',
      );
    }
    return injectedClient;
  }
  const kafkajs = await loadKafkajs();
  const kafka = new kafkajs.Kafka({ clientId, brokers: brokers as string[] });
  return kafka as unknown as IKafkaFactory;
}

/**
 * Internal consumer entry.
 */
interface ActiveConsumer {
  id: string;
  consumer: unknown;
  running: boolean;
}

/**
 * Kafka message broker implementation.
 *
 * @since 0.1.0
 */
export class KafkaBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #brokers: readonly string[];
  #clientId: string;
  #injectedClient: IKafkaFactory | undefined;
  #defaultQueue: string;
  #replyTopic: string;
  #factory: IKafkaFactory | null = null;
  #producer: unknown | null = null;
  #ready = false;
  #activeConsumers: Map<string, ActiveConsumer>;
  #rr: RequestReplyCore;

  /**
   * Creates a new Kafka broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   * @param options - Kafka connection and configuration options
   */
  constructor(
    runtime: IRuntimeServices,
    serializer: ISerializer,
    options?: KafkaOptions,
  ) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#brokers = options?.brokers ?? ['localhost:9092'];
    this.#clientId = options?.clientId ?? 'messaging-client';
    this.#injectedClient = options?.client;
    this.#defaultQueue = options?.defaultQueue ?? 'messaging-consumers';
    this.#replyTopic = options?.replyTopic ?? DEFAULT_REPLY_TOPIC;
    this.#activeConsumers = new Map();
    this.#rr = new RequestReplyCore({
      publish: (topic, message) => this.publish(topic, message),
      subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
      uuid: () => this.#runtime.uuid(),
      setTimeout: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => this.#runtime.clearTimeout(handle),
      openInbox: (onReply) => this.#openReplyInbox(onReply),
    });
  }

  /**
   * Opens this broker's reply inbox on the shared reply topic.
   *
   * Kafka cannot use the per-instance topic {@link createTopicInbox} mints: a
   * topic here is a durable, partitioned cluster resource, and `IKafkaFactory`
   * exposes no admin surface to create or drop one. Instead every instance
   * reads ONE reply topic under a consumer group unique to itself, so delivery
   * is exclusive rather than load-balanced across the shared default group.
   * Replies addressed to other instances arrive here too and are dropped by
   * correlation-id lookup, which costs O(instances) fan-out but needs no admin
   * API and leaves no topic behind — only a consumer group, which Kafka expires
   * on `offsets.retention.minutes`.
   *
   * @param onReply - Invoked per message delivered to the reply topic
   * @returns The open inbox, addressed at the shared reply topic
   */
  async #openReplyInbox(onReply: (message: unknown) => void): Promise<ReplyInbox> {
    const subscription = await this.subscribe(this.#replyTopic, (message) => {
      onReply(message);
    }, { queue: `${REPLY_GROUP_PREFIX}${this.#runtime.uuid()}` });

    return {
      address: this.#replyTopic,
      close: (): Promise<void> => subscription.unsubscribe(),
    };
  }

  /**
   * Connects to Kafka and creates producer.
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    this.#factory = await resolveClient(this.#brokers, this.#clientId, this.#injectedClient);

    // Build producer unconditionally from the resolved factory
    const realFactory = this.#factory as unknown as { producer(): unknown };
    this.#producer = realFactory.producer();
    await (this.#producer as unknown as { connect(): Promise<void> }).connect();

    this.#ready = true;
  }

  /**
   * Disconnects from Kafka.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  async disconnect(): Promise<void> {
    // Reject in-flight requests and close the reply inbox before the transport
    // goes away, so no timer or subscription outlives the connection.
    await this.#rr.close();

    // Stop all active consumers
    for (const consumer of this.#activeConsumers.values()) {
      try {
        const realConsumer = consumer.consumer as unknown as { stop(): Promise<void> };
        consumer.running = false;
        await realConsumer.stop();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.#activeConsumers.clear();

    if (this.#producer) {
      try {
        await (this.#producer as unknown as { disconnect(): Promise<void> }).disconnect();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.#producer = null;
    this.#factory = null;
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
    if (!this.#producer) {
      throw new Error('KafkaBroker is not connected');
    }
    const serialized = this.#serializer.serialize(message);

    const realProducer = this.#producer as unknown as {
      send(options: { topic: string; messages: unknown }): Promise<void>;
    };

    await realProducer.send({
      topic,
      messages: [{
        value: serialized,
        headers: typeof message === 'object' && message !== null
          ? (message as Record<string, string>)
          : undefined,
      }],
    });
  }

  /**
   * Subscribes to a topic using a consumer group.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic to subscribe to
   * @param handler - The handler to invoke for each message
   * @param options - Optional subscription options (queue for consumer group ID)
   * @returns The subscription handle
   * @since 0.1.0
   */
  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    if (!this.#factory) {
      throw new Error('KafkaBroker is not connected');
    }

    const subscriptionId = this.#runtime.uuid();
    const groupId = options?.queue ?? this.#defaultQueue;

    // Create consumer unconditionally from the resolved factory
    const realFactory = this.#factory as unknown as {
      consumer(options: { groupId: string }): unknown;
    };
    const realConsumer = realFactory.consumer({ groupId });

    const consumerTyped = realConsumer as unknown as {
      connect(): Promise<void>;
      subscribe(options: { topic: string; fromBeginning?: boolean }): Promise<void>;
      run(
        options: {
          eachMessage: (
            data: { topic: string; partition: number; message: unknown },
          ) => Promise<void>;
        },
      ): Promise<void>;
      stop(): Promise<void>;
      disconnect(): Promise<void>;
    };

    await consumerTyped.connect();
    await consumerTyped.subscribe({ topic, fromBeginning: false });

    const activeConsumer: ActiveConsumer = {
      id: subscriptionId,
      consumer: realConsumer,
      running: true,
    };
    this.#activeConsumers.set(subscriptionId, activeConsumer);

    // Run consumer with eachMessage handler
    consumerTyped.run({
      eachMessage: async ({ message }) => {
        const msgTyped = message as unknown as {
          key: Uint8Array | null;
          value: Uint8Array | null;
          timestamp: string;
          headers: Record<string, Uint8Array>;
          partition: number;
          offset: string;
        };

        const valueBytes = msgTyped.value ?? new Uint8Array(0);
        const content = new TextDecoder().decode(valueBytes);
        const deserialized = this.#serializer.deserialize<T>(content);

        const metadata: MessageMetadata = {
          topic,
          messageId: `${msgTyped.partition}:${msgTyped.offset}`,
          timestamp: new Date(parseInt(msgTyped.timestamp, 10)),
          headers: Object.fromEntries(
            Object.entries(msgTyped.headers).map(([k, v]) => [k, new TextDecoder().decode(v)]),
          ),
        };

        // Handler success triggers auto-commit; failure prevents commit
        await handler(deserialized, metadata);
      },
    });

    return {
      unsubscribe: async (): Promise<void> => {
        const consumer = this.#activeConsumers.get(subscriptionId);
        if (consumer) {
          consumer.running = false;
          try {
            const realSub = consumer.consumer as unknown as { stop(): Promise<void> };
            await realSub.stop();
          } catch {
            // Ignore errors
          }
          this.#activeConsumers.delete(subscriptionId);
        }
      },
    };
  }

  /**
   * Sends a request and awaits its single correlated reply.
   *
   * Replies arrive on the shared reply topic ({@link KafkaOptions.replyTopic},
   * default `'messaging.replies'`), which **must exist** — this broker creates
   * no topics, because `IKafkaFactory` exposes no admin surface. Either
   * pre-create it or enable `auto.create.topics.enable`; otherwise the
   * underlying producer error surfaces from this call rather than hanging until
   * the timeout.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic a responder is listening on
   * @param message - The request payload
   * @param options - Reply timeout behavior
   * @returns The reply payload
   * @throws {RequestTimeoutError} When no reply arrives within `timeoutMs`
   * @throws {RemoteHandlerError} When the responder throws
   * @since 0.1.0
   */
  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes> {
    return this.#rr.request<TRes>(topic, message, options);
  }

  /**
   * Registers a responder for a request topic. The handler's resolved value is
   * sent back to the caller, correlated to the originating request.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - The request topic to respond on
   * @param handler - Invoked per request; its result is returned to the caller
   * @param options - Consumer group behavior (load-balance competing responders)
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
      handler as (message: unknown, metadata: MessageMetadata) => unknown | Promise<unknown>,
      options,
    );
  }
}
