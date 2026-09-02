/**
 * Internal behaviour-chain decorator for message brokers (M86 §3.8).
 *
 * ONE decorator composes the ingress behaviour chain inside
 * `subscribe`/`subscribeWithHeaders` for ALL broker arms — the ten broker
 * constructors are untouched, and the underlying broker never learns the
 * chain exists. This is the `TracedBroker` decorator shape applied to the
 * behaviour chain.
 *
 * Deliberately NOT barrel-exported: it reaches an application only as the
 * registered `MessageBrokerAdapter`, and `deno doc --lint` rejects an export
 * leaking this internal type (the `BigtableTransaction` precedent).
 *
 * @module
 */

import type {
  IIngressBehavior,
  IngressContext,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import { composeBehaviorChain } from '@setu-ts/common';
import type { MessageBrokerAdapter } from '../brokers/message-broker.ts';

/**
 * Wraps a broker so every subscription handler runs the messaging arm of the
 * transport-neutral ingress behaviour chain. @internal
 *
 * The behaviour list is read LIVE on every delivery — when factories are
 * configured, the plugin's `onInit` hook replaces the SAME array with the
 * full resolved sequence after subscriptions were registered, so those wrap
 * handlers registered earlier without re-subscribing.
 *
 * `respond` (brokered request-reply) is forwarded UNWRAPPED: the RPC
 * responder is a fifth developer-supplied handler that RETURNS a value where
 * the four ingress handlers are void, and it gets no arm and no chain in this
 * milestone (M86 §3.12) — pinned rather than assumed by
 * `test/unit/pipelined-broker.test.ts`.
 */
export class PipelinedBroker implements MessageBrokerAdapter {
  readonly #broker: MessageBrokerAdapter;
  readonly #behaviors: readonly IIngressBehavior[];
  /**
   * Held until the behaviour chain is FINAL, then cleared so the steady state
   * costs nothing.
   *
   * A subscription goes live the instant it is established against the
   * already-connected broker, and a broker holding a backlog delivers
   * immediately — while behaviour FACTORIES cannot resolve until `onInit`,
   * the first phase at which the registry holds every capability. Without
   * this gate a message arriving in that window reaches the handler having
   * run only the INSTANCE behaviours, silently skipping exactly the ones that
   * needed a resolved capability. Deferring the plugin's own declared
   * subscriptions is NOT sufficient: a later plugin resolves this broker in
   * its own `register()` and subscribes there, which no amount of deferral
   * inside this plugin can reach. Gating DELIVERY closes both doors with one
   * mechanism, and leaves every registration's timing unchanged.
   *
   * `undefined` when no behaviour factory is configured: the chain is already
   * final at construction and delivery is never deferred.
   */
  #chainReady: Promise<void> | undefined;

  constructor(
    broker: MessageBrokerAdapter,
    behaviors: readonly IIngressBehavior[],
    chainReady?: Promise<void>,
  ) {
    this.#broker = broker;
    this.#behaviors = behaviors;
    this.#chainReady = chainReady;
    // Clear the gate once settled so later deliveries take the direct path.
    // A REJECTED gate is deliberately left in place: startup failed, the
    // chain is never completed, and delivering through a partial chain is the
    // outcome this exists to prevent.
    void chainReady?.then(() => {
      this.#chainReady = undefined;
    }, () => {});
  }

  connect(): Promise<void> {
    return this.#broker.connect();
  }

  disconnect(): Promise<void> {
    return this.#broker.disconnect();
  }

  isReady(): boolean {
    return this.#broker.isReady();
  }

  reachability(): Promise<boolean | undefined> {
    return this.#broker.reachability();
  }

  isHealthy(): Promise<boolean> {
    return this.#broker.isHealthy?.() ?? Promise.resolve(true);
  }

  /** Publishes through the underlying broker — publishing is not ingress work. */
  publish<T>(topic: string, message: T): Promise<void> {
    return this.#broker.publish(topic, message);
  }

  publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    return this.#broker.publishWithHeaders(topic, message, headers);
  }

  subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.subscribeWithHeaders(topic, handler, options);
  }

  /**
   * Subscribes through the underlying broker with the handler wrapped in the
   * behaviour chain — the decorator's SINGLE insertion point.
   *
   * The envelope is built PER DELIVERY and is immutable, carrying
   * `kind: 'messaging'`, the topic as `name`, the delivered message as
   * `payload`, and the transport headers from `MessageMetadata` when the
   * channel carried any. There is deliberately NO `attempt`: brokers
   * redeliver and none tracks a delivery count, so a fabricated number would
   * lie (M86 §3.3). The wrapped handler keeps its native
   * `(message, metadata)` signature; only the chain sees the envelope.
   */
  subscribeWithHeaders<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    const dispatch = (message: unknown, metadata: MessageMetadata): void | Promise<void> => {
      if (this.#behaviors.length === 0) {
        return handler(message as T, metadata);
      }

      const envelope: IngressContext = {
        kind: 'messaging',
        name: topic,
        payload: message as T,
        ...(metadata.headers !== undefined ? { headers: metadata.headers } : {}),
      };
      return composeBehaviorChain<IngressContext, void>(
        envelope,
        this.#behaviors,
        () => Promise.resolve(handler(message as T, metadata)),
      );
    };

    return this.#broker.subscribeWithHeaders(
      topic,
      (message, metadata) => {
        // Read the gate PER DELIVERY: it is cleared once the chain is final,
        // so only messages arriving in the startup window are deferred.
        const gate = this.#chainReady;
        // The deferred result is RETURNED, not discarded: a handler rejection
        // must still reach the broker's own failure path (a nack/redelivery),
        // never become an unhandled rejection.
        return gate === undefined
          ? dispatch(message, metadata)
          : gate.then(() => dispatch(message, metadata));
      },
      options,
    );
  }

  /** Sends RPC traffic through the underlying broker — the caller side of RPC. */
  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes> {
    return this.#broker.request(topic, message, options);
  }

  requestWithHeaders<TReq, TRes>(
    topic: string,
    message: TReq,
    headers: Readonly<Record<string, string>>,
    options?: RequestOptions,
  ): Promise<TRes> {
    return this.#broker.requestWithHeaders(topic, message, headers, options);
  }

  /**
   * Registers a responder through the underlying broker UNWRAPPED — no chain
   * sits in front of the RPC handler (M86 §3.12 deferral, pinned by test).
   */
  respond<TReq, TRes>(
    topic: string,
    handler: RequestHandler<TReq, TRes>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.#broker.respond(topic, handler, options);
  }
}
