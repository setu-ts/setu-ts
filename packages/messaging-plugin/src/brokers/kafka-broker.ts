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
import { MessagingNotSupportedError } from '../errors.ts';
import type { IKafkaFactory, KafkaOptions } from '../interfaces/index.ts';

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
  #factory: IKafkaFactory | null = null;
  #producer: unknown | null = null;
  #ready = false;
  #activeConsumers: Map<string, ActiveConsumer>;

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
    this.#activeConsumers = new Map();
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
   * Kafka does not support brokered request-reply: its consumer-group and
   * auto-commit delivery model makes per-caller reply correlation an
   * anti-pattern. Use a reply-capable broker instead.
   *
   * @throws {MessagingNotSupportedError} Always
   * @since 0.1.0
   */
  request<TReq, TRes>(_topic: string, _message: TReq, _options?: RequestOptions): Promise<TRes> {
    throw new MessagingNotSupportedError();
  }

  /**
   * Kafka does not support brokered request-reply. See {@link KafkaBroker.request}.
   *
   * @throws {MessagingNotSupportedError} Always
   * @since 0.1.0
   */
  respond<TReq, TRes>(
    _topic: string,
    _handler: RequestHandler<TReq, TRes>,
    _options?: SubscribeOptions,
  ): Promise<ISubscription> {
    throw new MessagingNotSupportedError();
  }
}
