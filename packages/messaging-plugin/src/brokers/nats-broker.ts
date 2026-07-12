import type {
  ISubscription,
  MessageHandler,
  MessageMetadata,
  SubscribeOptions,
} from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import type { INatsConnection, NatsOptions } from '../interfaces/index.ts';

/**
 * Lazily load nats at runtime.
 *
 * @returns The nats module
 * @throws {Error} If the npm:nats package cannot be resolved
 */
async function loadNats(): Promise<typeof import('npm:nats@2.x')> {
  const mod = await import('npm:nats@2.x');
  return mod;
}

/**
 * Structural validation for NATS connection.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is INatsConnection {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['jetstream', 'jetstreamManager', 'close'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the NATS connection: prefer injected client, then lazy-load nats.
 *
 * @param url - NATS connection URL(s)
 * @param injectedClient - Optionally injected NATS connection
 * @returns The resolved connection
 * @throws {Error} If no client injected and nats cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient?: INatsConnection,
): Promise<INatsConnection> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected NATS client does not match the required structural shape ' +
          '(needs: jetstream, jetstreamManager, close)',
      );
    }
    return injectedClient;
  }
  const nats = await loadNats();
  const connection = await nats.connect({ servers: url });
  return connection as unknown as INatsConnection;
}

/**
 * Internal consumer entry.
 */
interface ActiveConsumer {
  id: string;
  consumer: unknown;
  subscription: unknown;
}

/**
 * NATS JetStream message broker implementation.
 *
 * @since 0.1.0
 */
export class NatsBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #url: string;
  #injectedClient: INatsConnection | undefined;
  #streamName: string;
  #connection: INatsConnection | null = null;
  #js: unknown | null = null;
  #ready = false;
  #activeConsumers: Map<string, ActiveConsumer>;

  /**
   * Creates a new NATS broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   * @param options - NATS connection and configuration options
   */
  constructor(
    runtime: IRuntimeServices,
    serializer: ISerializer,
    options?: NatsOptions,
  ) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#url = options?.url ?? 'nats://localhost:4222';
    this.#injectedClient = options?.client;
    this.#streamName = options?.streamName ?? 'MESSAGING';
    this.#activeConsumers = new Map();
  }

  /**
   * Connects to NATS and ensures JetStream stream exists.
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    this.#connection = await resolveClient(this.#url, this.#injectedClient);

    if (!this.#injectedClient) {
      const nats = await loadNats();
      const realConn = this.#connection as unknown as Awaited<ReturnType<typeof nats.connect>>;
      // Ensure stream exists
      const jsm = await realConn.jetstreamManager();
      try {
        await jsm.streams.info(this.#streamName);
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('stream not found')) {
          await jsm.streams.add({
            name: this.#streamName,
            subjects: ['>'],
          });
        } else {
          throw e;
        }
      }
    } else {
      // For injected client, ensure stream exists
      const realConn = this.#connection as unknown as { jetstreamManager(): Promise<unknown> };
      await realConn.jetstreamManager();
      // Stream ensure logic would go here if jsm exposes streams.add
      // For now, we assume stream exists or is created externally
      // Get JetStream instance for injected client
      const realConn2 = this.#connection as unknown as { jetstream(): unknown };
      this.#js = realConn2.jetstream();
    }

    // Get JetStream instance
    if (!this.#injectedClient) {
      const realConn = this.#connection as unknown as { jetstream(): unknown };
      this.#js = realConn.jetstream();
    }
    this.#ready = true;
  }

  /**
   * Disconnects from NATS.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  disconnect(): Promise<void> {
    // Stop all active consumers
    for (const consumer of this.#activeConsumers.values()) {
      try {
        const realConsumer = consumer.consumer as unknown as { stop(): void };
        realConsumer.stop();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.#activeConsumers.clear();
    if (this.#connection) {
      const realConn = this.#connection as unknown as { close(): void };
      realConn.close();
    }
    this.#connection = null;
    this.#js = null;
    this.#ready = false;
    return Promise.resolve();
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
   * Publishes a message to a subject (topic).
   *
   * @typeParam T - The message payload type
   * @param topic - The subject to publish to
   * @param message - The message payload
   * @returns Resolves when published
   * @since 0.1.0
   */
  publish<T>(topic: string, message: T): Promise<void> {
    if (!this.#connection) {
      return Promise.reject(new Error('NatsBroker is not connected'));
    }
    if (!this.#js) {
      return Promise.reject(new Error('JetStream is not initialized'));
    }
    const serialized = this.#serializer.serialize(message);
    const encoder = new TextEncoder();
    const data = encoder.encode(serialized);

    const realJs = this.#js as unknown as { publish(subject: string, data: Uint8Array): void };
    realJs.publish(topic, data);
    return Promise.resolve();
  }

  /**
   * Subscribes to a topic using JetStream durable consumers.
   *
   * @typeParam T - The message payload type
   * @param topic - The subject to subscribe to
   * @param handler - The handler to invoke for each message
   * @param options - Optional subscription options (queue for durable consumer name)
   * @returns The subscription handle
   * @since 0.1.0
   */
  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    if (!this.#connection) {
      throw new Error('NatsBroker is not connected');
    }

    const subscriptionId = this.#runtime.uuid();
    const consumerName = options?.queue ?? `messaging-${this.#runtime.uuid()}`;

    // Get JetStream instance
    if (!this.#js) {
      throw new Error('JetStream is not initialized');
    }
    const realJs = this.#js;

    const realJsTyped = realJs as unknown as {
      consumers: {
        add(stream: string, config: unknown): Promise<unknown>;
        get(stream: string, consumer: string): Promise<unknown>;
      };
    };

    // Ensure durable consumer exists
    try {
      await realJsTyped.consumers.add(this.#streamName, {
        name: consumerName,
        filter_subject: topic,
        durable_name: consumerName,
        ack_policy: 'explicit',
      });
    } catch (err) {
      const e = err as Error;
      // Consumer may already exist - that's fine
      if (
        !e.message.includes('consumer name already exists') &&
        !e.message.includes('duplicate')
      ) {
        throw e;
      }
    }

    // Get consumer and start consuming
    const consumer = await realJsTyped.consumers.get(this.#streamName, consumerName);
    const consumerTyped = consumer as unknown as {
      consume(options: { callback: (msg: unknown) => void }): unknown;
    };

    const subscription = consumerTyped.consume({
      callback: (msg) => {
        const msgTyped = msg as unknown as {
          data: Uint8Array;
          seq: number;
          info: { timestamp: string };
          headers: unknown;
          ack(): void;
          nak(): void;
        };

        const content = new TextDecoder().decode(msgTyped.data);
        const deserialized = this.#serializer.deserialize<T>(content);

        const metadata: MessageMetadata = {
          topic,
          messageId: String(msgTyped.seq),
          timestamp: new Date(msgTyped.info.timestamp),
          headers: (msgTyped.headers as Readonly<Record<string, string>>) ?? undefined,
        };

        const handlerResult = handler(deserialized, metadata);
        if (handlerResult instanceof Promise) {
          handlerResult.then(() => {
            msgTyped.ack();
          }).catch(() => {
            msgTyped.nak();
          });
        } else {
          msgTyped.ack();
        }
      },
    });

    const activeConsumer: ActiveConsumer = {
      id: subscriptionId,
      consumer,
      subscription,
    };
    this.#activeConsumers.set(subscriptionId, activeConsumer);

    return {
      unsubscribe: (): Promise<void> => {
        const consumer = this.#activeConsumers.get(subscriptionId);
        if (consumer) {
          try {
            const realSub = consumer.subscription as unknown as { stop(): void };
            realSub.stop();
          } catch {
            // Ignore errors
          }
          this.#activeConsumers.delete(subscriptionId);
        }
        return Promise.resolve();
      },
    };
  }
}
