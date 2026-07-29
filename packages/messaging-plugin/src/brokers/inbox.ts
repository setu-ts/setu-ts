/**
 * The reply-inbox seam every reply-capable broker supplies to
 * {@link RequestReplyCore}.
 *
 * A broker's inbox is where its correlated replies arrive. What an inbox *is*
 * differs per transport: on brokers whose topics are cheap and
 * per-instance-addressable (in-memory, Redis Streams, RabbitMQ, NATS) it is a
 * freshly minted topic, which {@link createTopicInbox} provides. On Kafka a
 * topic is a durable, partitioned cluster resource, so its broker supplies an
 * inbox over a shared reply topic read by a per-instance consumer group
 * instead. Owning that choice per broker — rather than having the core impose a
 * topic string — is what lets a transport participate at all.
 *
 * @module
 */

import type { ISubscription, MessageMetadata, SubscribeOptions } from '@hono-enterprise/common';

/** Prefix for the per-instance topics {@link createTopicInbox} mints. */
const TOPIC_INBOX_PREFIX = 'rr.inbox.';

/**
 * An open reply inbox: the address responders send replies to, plus its
 * teardown.
 *
 * @since 0.1.0
 */
export interface ReplyInbox {
  /**
   * The address a responder publishes replies to. Travels to the responder as
   * the `replyTo` field of each request envelope.
   */
  readonly address: string;
  /**
   * Closes the inbox and releases whatever the transport allocated for it.
   */
  close(): Promise<void>;
}

/**
 * Opens a reply inbox, routing every message it receives to `onReply`.
 *
 * @param onReply - Invoked per message delivered to the inbox
 * @returns The open inbox
 * @since 0.1.0
 */
export type OpenInbox = (onReply: (message: unknown) => void) => Promise<ReplyInbox>;

/** The broker primitives {@link createTopicInbox} composes. */
export interface TopicInboxDeps {
  /** Subscribe to a topic (the broker's own `subscribe`). */
  subscribe(
    topic: string,
    handler: (message: unknown, metadata: MessageMetadata) => void | Promise<void>,
    options?: SubscribeOptions,
  ): Promise<ISubscription>;
  /** Inbox-address source (the broker's `runtime.uuid`). */
  uuid(): string;
}

/**
 * Builds an {@link OpenInbox} that mints one fresh topic per call and
 * subscribes to it.
 *
 * The subscription claims its own queue name — the inbox topic itself — so a
 * broker with competing-consumer semantics delivers replies to *this* instance
 * rather than load-balancing them across whichever consumers share a default
 * group. On brokers where each inbox topic already has exactly one subscriber
 * this is a no-op; it is load-bearing wherever an absent queue falls back to a
 * shared group.
 *
 * @param deps - The broker's `subscribe` and `uuid`
 * @returns An {@link OpenInbox} for brokers whose topics are cheap and
 * per-instance-addressable
 * @example
 * ```typescript
 * new RequestReplyCore({
 *   openInbox: createTopicInbox({ subscribe, uuid: () => runtime.uuid() }),
 *   // …
 * });
 * ```
 * @since 0.1.0
 */
export function createTopicInbox(deps: TopicInboxDeps): OpenInbox {
  return async (onReply: (message: unknown) => void): Promise<ReplyInbox> => {
    // Unique per open so replies never cross-talk between broker instances.
    const address = `${TOPIC_INBOX_PREFIX}${deps.uuid()}`;
    const subscription = await deps.subscribe(address, (message) => {
      onReply(message);
    }, { queue: address });

    return {
      address,
      close: (): Promise<void> => subscription.unsubscribe(),
    };
  };
}
