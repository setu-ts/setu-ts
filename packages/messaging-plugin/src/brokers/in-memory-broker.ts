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

/**
 * Internal subscriber entry.
 */
interface Subscriber {
  id: string;
  handler: MessageHandler<unknown>;
  queue?: string;
}

/**
 * In-memory message broker implementation.
 *
 * Provides fanout delivery to subscribers without a queue, and
 * load-balanced (round-robin) delivery to subscribers within a queue.
 *
 * @since 0.1.0
 */
export class InMemoryBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #subscribers: Map<string, Subscriber[]>;
  #queueCursors: Map<string, Map<string, number>>; // topic -> queue -> cursor
  #ready = false;
  #rr: RequestReplyCore;

  /**
   * Creates a new in-memory broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   */
  constructor(runtime: IRuntimeServices, serializer: ISerializer) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#subscribers = new Map();
    this.#queueCursors = new Map();
    this.#rr = new RequestReplyCore({
      publish: (topic, message) => this.publish(topic, message),
      subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
      uuid: () => this.#runtime.uuid(),
      setTimeout: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => this.#runtime.clearTimeout(handle),
    });
  }

  /**
   * Connects the broker (idempotent no-op for in-memory).
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  // deno-lint-ignore require-await
  async connect(): Promise<void> {
    this.#ready = true;
  }

  /**
   * Disconnects the broker and clears all subscriptions.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  async disconnect(): Promise<void> {
    await this.#rr.close();
    this.#subscribers.clear();
    this.#queueCursors.clear();
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
   * Delivers to all subscribers without a queue (fanout), and to one
   * subscriber per queue (round-robin load balancing).
   *
   * @typeParam T - The message payload type
   * @param topic - The topic to publish to
   * @param message - The message payload
   * @returns Resolves when all handlers have been invoked
   * @since 0.1.0
   */
  async publish<T>(topic: string, message: T): Promise<void> {
    const subs = this.#subscribers.get(topic) ?? [];
    if (subs.length === 0) {
      return;
    }

    const metadata: MessageMetadata = {
      topic,
      messageId: this.#runtime.uuid(),
      timestamp: new Date(this.#runtime.now()),
    };

    const serialized = this.#serializer.serialize(message);
    const deserialized = this.#serializer.deserialize<T>(serialized);

    // Partition subscribers by queue
    const noQueueSubs: Subscriber[] = [];
    const queueMap = new Map<string, Subscriber[]>();

    for (const sub of subs) {
      if (sub.queue === undefined) {
        noQueueSubs.push(sub);
      } else {
        const queue = sub.queue;
        if (!queueMap.has(queue)) {
          queueMap.set(queue, []);
        }
        queueMap.get(queue)!.push(sub);
      }
    }

    // Deliver to all no-queue subscribers (fanout)
    for (const sub of noQueueSubs) {
      await sub.handler(deserialized, metadata);
    }

    // Deliver to one subscriber per queue (round-robin)
    for (const [queue, queueSubs] of queueMap.entries()) {
      if (queueSubs.length === 0) {
        continue;
      }

      // Initialize cursor if not present
      if (!this.#queueCursors.has(topic)) {
        this.#queueCursors.set(topic, new Map());
      }
      const topicCursors = this.#queueCursors.get(topic)!;

      if (!topicCursors.has(queue)) {
        topicCursors.set(queue, 0);
      }
      const cursor = topicCursors.get(queue)!;

      // Round-robin: select subscriber at cursor position
      const selectedSub = queueSubs[cursor % queueSubs.length];
      await selectedSub.handler(deserialized, metadata);

      // Advance cursor
      topicCursors.set(queue, (cursor + 1) % queueSubs.length);
    }
  }

  /**
   * Subscribes to a topic.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic to subscribe to
   * @param handler - The handler to invoke for each message
   * @param options - Optional subscription options (queue for load balancing)
   * @returns The subscription handle
   * @since 0.1.0
   */
  // deno-lint-ignore require-await
  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    const id = this.#runtime.uuid();
    const subscriber: Subscriber = {
      id,
      handler: handler as MessageHandler<unknown>,
      ...(options?.queue && { queue: options.queue }),
    };

    if (!this.#subscribers.has(topic)) {
      this.#subscribers.set(topic, []);
    }
    this.#subscribers.get(topic)!.push(subscriber);

    return {
      // deno-lint-ignore require-await
      unsubscribe: async (): Promise<void> => {
        const subs = this.#subscribers.get(topic);
        if (subs) {
          const idx = subs.findIndex((s) => s.id === id);
          if (idx !== -1) {
            subs.splice(idx, 1);
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
