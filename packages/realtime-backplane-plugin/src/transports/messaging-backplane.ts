/**
 * Backplane transport over the registered message broker.
 *
 * @module
 * @since 0.2.0
 */

import type {
  IMessageBroker,
  IRealtimeBackplane,
  ISubscription,
  RealtimeFrame,
  RealtimeFrameHandler,
} from '@hono-enterprise/common';

/**
 * Narrows an arriving broker payload to a {@linkcode RealtimeFrame}.
 *
 * A broker topic is shared infrastructure, so a malformed or foreign message
 * must be dropped rather than crash the delivery loop or reach a consumer as a
 * half-built frame.
 *
 * @param value - The deserialized broker payload
 * @returns True when `value` is a well-formed frame
 * @since 0.2.0
 */
export function isRealtimeFrame(value: unknown): value is RealtimeFrame {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const frame = value as Partial<RealtimeFrame>;
  return (
    (frame.kind === 'ws-room' || frame.kind === 'sse-channel') &&
    typeof frame.origin === 'string' &&
    typeof frame.name === 'string' &&
    typeof frame.data === 'string' &&
    (frame.binary === undefined || typeof frame.binary === 'boolean')
  );
}

/**
 * Carries frames over whatever broker is registered under
 * `CAPABILITIES.MESSAGING`.
 *
 * This reuses every broker the messaging plugin already ships — in-memory,
 * Redis Streams, RabbitMQ, NATS, Kafka — and adds no dependency of its own.
 * The broker's own `connect`/`disconnect` are left to its owning plugin; this
 * transport only publishes and subscribes.
 *
 * @since 0.2.0
 */
export class MessagingBackplane implements IRealtimeBackplane {
  readonly origin: string;
  readonly #broker: IMessageBroker;
  readonly #topic: string;
  readonly #handlers = new Set<RealtimeFrameHandler>();
  #subscription: ISubscription | undefined;

  /**
   * @param broker - The broker resolved from `CAPABILITIES.MESSAGING`
   * @param origin - This instance's identity
   * @param topic - The topic every instance shares
   */
  constructor(broker: IMessageBroker, origin: string, topic: string) {
    this.#broker = broker;
    this.origin = origin;
    this.#topic = topic;
  }

  /**
   * Opens the shared subscription.
   *
   * One broker subscription serves every handler: a per-handler subscription
   * would make each consumer plugin a competing consumer on brokers that
   * load-balance, so only one of them would see any given frame.
   */
  async connect(): Promise<void> {
    if (this.#subscription !== undefined) {
      return;
    }
    this.#subscription = await this.#broker.subscribe<unknown>(
      this.#topic,
      (message): void => {
        if (!isRealtimeFrame(message)) {
          return;
        }
        if (message.origin === this.origin) {
          return;
        }
        for (const handler of this.#handlers) {
          handler(message);
        }
      },
    );
  }

  async publish(frame: RealtimeFrame): Promise<void> {
    await this.#broker.publish(this.#topic, frame);
  }

  subscribe(handler: RealtimeFrameHandler): Promise<() => void> {
    this.#handlers.add(handler);
    return Promise.resolve(() => {
      this.#handlers.delete(handler);
    });
  }

  async close(): Promise<void> {
    this.#handlers.clear();
    const subscription = this.#subscription;
    this.#subscription = undefined;
    if (subscription !== undefined) {
      await subscription.unsubscribe();
    }
  }
}
