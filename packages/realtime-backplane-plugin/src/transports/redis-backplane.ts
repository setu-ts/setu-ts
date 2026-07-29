/**
 * Redis pub/sub backplane transport.
 *
 * @module
 * @since 0.2.0
 */

import type {
  IRealtimeBackplane,
  RealtimeFrame,
  RealtimeFrameHandler,
} from '@hono-enterprise/common';
import type { IRedisBackplaneClient, RedisBackplaneOptions } from '../interfaces/index.ts';
import { isRealtimeFrame } from './messaging-backplane.ts';
import { loadRedisModule } from './redis-module.ts';

/**
 * Carries frames over Redis pub/sub.
 *
 * **Two connections, deliberately.** A Redis connection in subscriber mode
 * refuses every command other than (un)subscribe, so publishing over the
 * subscribed connection fails at runtime. That is a property of the Redis
 * protocol rather than of `ioredis`, and it is invisible to any test driven
 * with a single fake — hence the constructor refuses an injected client that
 * arrives without its subscriber.
 *
 * @example
 * ```typescript
 * app.register(RealtimeBackplanePlugin({
 *   transport: 'redis',
 *   url: 'redis://localhost:6379',
 * }));
 * ```
 * @since 0.2.0
 */
export class RedisBackplane implements IRealtimeBackplane {
  readonly origin: string;
  readonly #topic: string;
  readonly #options: RedisBackplaneOptions;
  readonly #handlers = new Set<RealtimeFrameHandler>();

  #publisher: IRedisBackplaneClient | undefined;
  #subscriber: IRedisBackplaneClient | undefined;
  #listener: ((channel: string, message: string) => void) | undefined;

  /**
   * @param options - The Redis arm's options
   * @param origin - This instance's identity
   * @param topic - The Redis channel every instance shares
   * @throws {Error} When exactly one of `client` and `subscriber` is injected,
   * or when neither those nor a `url` is configured
   */
  constructor(options: RedisBackplaneOptions, origin: string, topic: string) {
    const hasClient = options.client !== undefined;
    const hasSubscriber = options.subscriber !== undefined;

    if (hasClient !== hasSubscriber) {
      throw new Error(
        'realtime-backplane: the redis transport needs BOTH options.client and ' +
          'options.subscriber. A Redis connection in subscriber mode refuses every ' +
          'other command, so one connection cannot both publish and subscribe.',
      );
    }
    if (!hasClient && (options.url === undefined || options.url === '')) {
      throw new Error(
        'realtime-backplane: the redis transport requires options.url when no ' +
          'client/subscriber pair is injected',
      );
    }

    this.#options = options;
    this.origin = origin;
    this.#topic = topic;
  }

  /** Builds the client pair when needed, then subscribes. */
  async connect(): Promise<void> {
    if (this.#subscriber !== undefined) {
      return;
    }

    if (this.#options.client !== undefined && this.#options.subscriber !== undefined) {
      this.#publisher = this.#options.client;
      this.#subscriber = this.#options.subscriber;
    } else {
      const module = this.#options.module ?? await loadRedisModule();
      const url = this.#options.url as string;
      this.#publisher = module.create(url);
      this.#subscriber = module.create(url);
    }

    const listener = (channel: string, message: string): void => {
      if (channel !== this.#topic) {
        return;
      }
      this.#dispatch(message);
    };
    this.#listener = listener;
    this.#subscriber.on('message', listener);
    await this.#subscriber.subscribe(this.#topic);
  }

  async publish(frame: RealtimeFrame): Promise<void> {
    // Always the publisher: the subscriber connection would reject this.
    await this.#publisher?.publish(this.#topic, JSON.stringify(frame));
  }

  subscribe(handler: RealtimeFrameHandler): Promise<() => void> {
    this.#handlers.add(handler);
    return Promise.resolve(() => {
      this.#handlers.delete(handler);
    });
  }

  async close(): Promise<void> {
    this.#handlers.clear();
    const subscriber = this.#subscriber;
    const publisher = this.#publisher;
    const listener = this.#listener;
    this.#subscriber = undefined;
    this.#publisher = undefined;
    this.#listener = undefined;

    if (subscriber !== undefined) {
      if (listener !== undefined) {
        subscriber.off('message', listener);
      }
      await subscriber.unsubscribe(this.#topic);
      await subscriber.quit();
    }
    if (publisher !== undefined && publisher !== subscriber) {
      await publisher.quit();
    }
  }

  /**
   * Parses a raw Redis message and hands it to the handlers.
   *
   * A channel is shared infrastructure, so unparseable or foreign traffic is
   * dropped rather than allowed to throw inside the driver's event listener,
   * where nothing would catch it.
   *
   * @param message - The raw message
   */
  #dispatch(message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!isRealtimeFrame(parsed) || parsed.origin === this.origin) {
      return;
    }
    for (const handler of this.#handlers) {
      handler(parsed);
    }
  }
}
