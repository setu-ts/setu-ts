import type {
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import type { InMemoryBrokerOptions } from '../interfaces/index.ts';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { createTopicInbox } from './inbox.ts';
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
  #options: InMemoryBrokerOptions | undefined;
  #subscribers: Map<string, Subscriber[]>;
  #queueCursors: Map<string, Map<string, number>>; // topic -> queue -> cursor
  #ready = false;
  #rr: RequestReplyCore;

  /**
   * Creates a new in-memory broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   * @param options - Optional behaviour, currently the dispatch-error reporter
   */
  constructor(runtime: IRuntimeServices, serializer: ISerializer, options?: InMemoryBrokerOptions) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#options = options;
    this.#subscribers = new Map();
    this.#queueCursors = new Map();
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
   * Tri-state backend reachability (M70c).
   *
   * There is no backend to be unreachable: the bus is in-process, so the
   * answer is simply whether the broker is running. `true` while ready,
   * `false` before `connect()` or after `disconnect()`.
   *
   * @returns `true` when the broker is running, `false` otherwise
   * @since 0.1.0
   */
  reachability(): Promise<boolean> {
    return Promise.resolve(this.#ready);
  }

  /**
   * Boolean port member (M70c).
   *
   * @returns `true` when the broker is running, `false` otherwise
   * @since 0.1.0
   */
  isHealthy(): Promise<boolean> {
    return this.reachability();
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
   * @returns Resolves once every matching subscription's work item has been
   * handed to dispatch — NOT once every handler has returned. A handler's
   * rejection reaches the configured `onDispatchError` (or is observed and
   * dropped when none is configured); it never rejects the publish and never
   * becomes an unhandled rejection. This is the guarantee real brokers give —
   * `publish` returns before delivery — so the in-memory double honours it
   * too. Since M89c it also means one slow or throwing fan-out handler no
   * longer delays or aborts delivery to its siblings.
   * @since 0.1.0
   */
  publish<T>(topic: string, message: T): Promise<void> {
    return this.publishWithHeaders(topic, message, {});
  }

  /**
   * Publishes a message with framework-owned transport headers. Resolves on
   * dispatch hand-off (see {@linkcode publish}); each invoked handler's
   * promise is RETAINED and its rejection routed to the failure path below —
   * never dropped, never unhandled. @internal
   */
  // Resolves-on-hand-off is the documented contract, not a forgotten await.
  // deno-lint-ignore require-await
  async publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    const subs = this.#subscribers.get(topic) ?? [];
    if (subs.length === 0) {
      return;
    }

    const metadata: MessageMetadata = {
      topic,
      messageId: this.#runtime.uuid(),
      timestamp: new Date(this.#runtime.now()),
      headers,
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

    // Deliver to all no-queue subscribers (fanout): INVOKE each, retain its
    // promise, and move on — no await, so one handler's completion or failure
    // never gates its siblings.
    for (const sub of noQueueSubs) {
      this.#invoke(sub, deserialized, metadata);
    }

    // Deliver to one subscriber per queue (round-robin), same hand-off.
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
      this.#invoke(selectedSub, deserialized, metadata);

      // Advance cursor
      topicCursors.set(queue, (cursor + 1) % queueSubs.length);
    }
  }

  /**
   * Hands one work item to a subscriber and RETAINS the returned promise.
   * A rejection — synchronous or asynchronous — is observed here and routed
   * to the broker's failure path, so a failing handler can never surface as
   * an unhandled rejection; without this retain, resolving `publish` on
   * hand-off would orphan every in-flight handler promise.
   */
  #invoke(sub: Subscriber, message: unknown, metadata: MessageMetadata): void {
    let result: void | Promise<void>;
    try {
      result = sub.handler(message, metadata);
    } catch (error) {
      this.#reportDispatchError(error, metadata);
      return;
    }
    void Promise.resolve(result).catch((error: unknown) => {
      this.#reportDispatchError(error, metadata);
    });
  }

  /**
   * The terminus of this broker's failure path. Unlike a real broker — where
   * a rejection reaching the failure path can nack and redeliver — the
   * in-memory double has no ack model and no redelivery, so reporting is the
   * whole of it: the rejection has been observed and settled, and with no
   * reporter configured it is dropped.
   */
  #reportDispatchError(error: unknown, metadata: MessageMetadata): void {
    const reporter = this.#options?.onDispatchError;
    if (reporter !== undefined) {
      reporter(error, metadata);
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
   * @returns The reply payload
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
}
