import type {
  ISubscription,
  MessageHandler,
  MessageMetadata,
  SubscribeOptions,
} from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import type { IRedisStreamsClient } from '../interfaces/index.ts';

/**
 * Lazily load ioredis at runtime. Pin to 5.x for stability.
 *
 * @returns The ioredis constructor
 * @throws {Error} If the npm:ioredis package cannot be resolved
 */
async function loadIoredis(): Promise<typeof import('npm:ioredis@5.x').Redis> {
  const mod = await import('npm:ioredis@5.x');
  return mod.Redis;
}

/**
 * Validate that the supplied object has the structural shape required by
 * RedisStreamsBroker. Checks the exact methods the broker calls — no duplicates.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IRedisStreamsClient {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['xadd', 'xgroup', 'xreadgroup', 'xack', 'quit', 'connect'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the Redis client: prefer injected `options.client`, then lazy-load
 * ioredis from npm.
 *
 * @param url - Redis connection URL
 * @param injectedClient - Optionally injected ioredis-compatible client
 * @returns The resolved client instance
 * @throws {Error} If no client injected and ioredis cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient?: IRedisStreamsClient,
): Promise<IRedisStreamsClient> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected Redis client does not match the required structural shape ' +
          '(needs: xadd, xgroup, xreadgroup, xack, quit, connect)',
      );
    }
    return injectedClient;
  }
  const RedisCtor = await loadIoredis();
  return new RedisCtor(url) as unknown as IRedisStreamsClient;
}

/**
 * Internal subscription entry for tracking poll loops.
 */
interface ActiveSubscription {
  id: string;
  unsubscribe: () => Promise<void>;
}

/**
 * Redis Streams message broker implementation.
 *
 * Uses Redis Streams for persistent message delivery with consumer groups
 * for load-balanced processing.
 *
 * @since 0.1.0
 */
export class RedisStreamsBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #url: string;
  #injectedClient: IRedisStreamsClient | undefined;
  #defaultQueue: string;
  #pollIntervalMs: number;
  #blockSizeMs: number;
  #logger?: { error: (msg: string) => void };
  #client: IRedisStreamsClient | null = null;
  #ready = false;
  #activeSubscriptions: Map<string, ActiveSubscription>;
  #pollIntervals: Map<string, number>; // subscription id -> interval id

  /**
   * Creates a new Redis Streams broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   * @param options - Redis connection and polling options
   */
  constructor(
    runtime: IRuntimeServices,
    serializer: ISerializer,
    options?: {
      url?: string;
      client?: IRedisStreamsClient;
      defaultQueue?: string;
      pollIntervalMs?: number;
      blockSizeMs?: number;
      logger?: { error: (msg: string) => void };
    },
  ) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#url = options?.url ?? 'redis://localhost:6379';
    this.#injectedClient = options?.client;
    this.#defaultQueue = options?.defaultQueue ?? 'messaging-consumers';
    this.#pollIntervalMs = options?.pollIntervalMs ?? 100;
    this.#blockSizeMs = options?.blockSizeMs ?? 100;
    if (options?.logger) {
      this.#logger = options.logger;
    }
    this.#activeSubscriptions = new Map();
    this.#pollIntervals = new Map();
  }

  /**
   * Connects the broker to Redis.
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    this.#client = await resolveClient(this.#url, this.#injectedClient);
    if (typeof this.#client.connect === 'function') {
      await this.#client.connect();
    }
    this.#ready = true;
  }

  /**
   * Disconnects the broker and clears all subscriptions.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  async disconnect(): Promise<void> {
    // Clear all active poll loops
    for (const intervalId of this.#pollIntervals.values()) {
      this.#runtime.clearInterval(intervalId);
    }
    this.#pollIntervals.clear();
    this.#activeSubscriptions.clear();

    if (this.#client) {
      await this.#client.quit();
    }
    this.#client = null;
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
   * Publishes a message to a topic (Redis stream).
   *
   * @typeParam T - The message payload type
   * @param topic - The topic (stream name) to publish to
   * @param message - The message payload
   * @returns Resolves when published
   * @since 0.1.0
   */
  async publish<T>(topic: string, message: T): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisStreamsBroker is not connected');
    }
    const serialized = this.#serializer.serialize(message);
    // XADD with '*' for auto-generated ID
    await this.#client.xadd(topic, '*', 'payload', serialized);
  }

  /**
   * Subscribes to a topic using Redis Streams consumer groups.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic (stream name) to subscribe to
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
    if (!this.#client) {
      throw new Error('RedisStreamsBroker is not connected');
    }

    const groupId = options?.queue ?? this.#defaultQueue;
    const consumerId = this.#runtime.uuid();
    const subscriptionId = this.#runtime.uuid();

    // Ensure the consumer group exists (swallow BUSYGROUP error)
    try {
      await this.#client.xgroup('CREATE', topic, groupId, '$', 'MKSTREAM');
    } catch (error) {
      // BUSYGROUP means the group already exists - that's fine
      const err = error as Error;
      if (!err.message.includes('BUSYGROUP')) {
        throw error;
      }
    }

    // In-flight guard to prevent overlapping polls
    let inFlight = false;

    // Poll loop using setInterval
    const poll = async (): Promise<void> => {
      if (inFlight) {
        return;
      }
      inFlight = true;

      try {
        // XREADGROUP to get new messages
        const result = await this.#client?.xreadgroup(
          'GROUP',
          groupId,
          consumerId,
          'COUNT',
          '10',
          'BLOCK',
          String(this.#blockSizeMs),
          'STREAMS',
          topic,
          '>',
        );

        if (result && result.length > 0) {
          const streamResult = result[0];
          const entries = streamResult[1] as Array<[string, Array<string>]>;

          for (const entry of entries) {
            const entryId = entry[0];
            const fields = entry[1];
            // fields is array of [field, value, field, value, ...]
            let payload: string | null = null;
            for (let i = 0; i < fields.length; i += 2) {
              if (fields[i] === 'payload') {
                payload = fields[i + 1] as string;
                break;
              }
            }

            if (payload === null) {
              continue;
            }

            const deserialized = this.#serializer.deserialize<T>(payload);
            const metadata: MessageMetadata = {
              topic,
              messageId: entryId,
              timestamp: new Date(parseInt(entryId.split('-')[0])),
            };

            try {
              await handler(deserialized, metadata);
              // Only ACK on success
              await this.#client?.xack(topic, groupId, entryId);
            } catch (error) {
              // Handler failed - don't ACK, leave in PEL
              this.#logger?.error(`Message handler failed: ${error}`);
            }
          }
        }
      } catch (error) {
        this.#logger?.error(`Poll error: ${error}`);
      } finally {
        inFlight = false;
      }
    };

    // Start the poll loop
    const intervalId = this.#runtime.setInterval(poll, this.#pollIntervalMs);
    this.#pollIntervals.set(subscriptionId, Number(intervalId));

    // deno-lint-ignore require-await
    const unsubscribe = async (): Promise<void> => {
      // Clear the poll interval
      if (this.#pollIntervals.has(subscriptionId)) {
        this.#runtime.clearInterval(this.#pollIntervals.get(subscriptionId)!);
        this.#pollIntervals.delete(subscriptionId);
      }
      this.#activeSubscriptions.delete(subscriptionId);
    };

    const subscription: ActiveSubscription = {
      id: subscriptionId,
      unsubscribe,
    };
    this.#activeSubscriptions.set(subscriptionId, subscription);

    return {
      unsubscribe,
    };
  }
}
