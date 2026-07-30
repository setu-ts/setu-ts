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
import { dispatchFrame } from './dispatch.ts';
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
  /** Errors thrown by subscribers during delivery, oldest first. */
  readonly #handlerErrors: Error[] = [];

  #publisher: IRedisBackplaneClient | undefined;
  #subscriber: IRedisBackplaneClient | undefined;
  #listener: ((channel: string, message: string) => void) | undefined;
  /**
   * The in-flight (or settled) open, so overlapping `connect()` calls join one
   * attempt instead of each building its own client pair. Cleared on failure so
   * a retry is possible, and on `close()` so a reopen actually reopens.
   */
  #opening: Promise<void> | undefined;

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

  /** Errors thrown by subscribers during delivery, oldest first. */
  get handlerErrors(): readonly Error[] {
    return this.#handlerErrors;
  }

  /**
   * Builds the client pair when needed, then subscribes.
   *
   * Idempotent and safe to call concurrently: the open is memoized, so two
   * overlapping calls join one attempt rather than each building — and leaking —
   * its own pair of connections. A failed attempt leaves the instance
   * unconnected with any connection it created already quit, and clears the memo
   * so a later call retries.
   *
   * @throws {Error} Whatever the module load, connection construction, or
   * SUBSCRIBE rejected with
   */
  async connect(): Promise<void> {
    this.#opening ??= this.#open();
    try {
      await this.#opening;
    } catch (error) {
      this.#opening = undefined;
      throw error;
    }
  }

  /**
   * Performs one open attempt, publishing its clients to the instance only once
   * the subscription is live.
   *
   * Nothing is assigned to `#publisher`/`#subscriber` until every step has
   * succeeded, so a half-built attempt cannot be mistaken for a connection by
   * `connect()`'s memo or leak a live socket past its own failure.
   *
   * @throws {Error} Whatever the module load, connection construction, or
   * SUBSCRIBE rejected with
   */
  async #open(): Promise<void> {
    let publisher: IRedisBackplaneClient;
    let subscriber: IRedisBackplaneClient;
    // Injected connections belong to the caller: on failure they are left as
    // they arrived, while connections built here are ours to clean up.
    let owned = false;

    if (this.#options.client !== undefined && this.#options.subscriber !== undefined) {
      publisher = this.#options.client;
      subscriber = this.#options.subscriber;
    } else {
      const module = this.#options.module ?? await loadRedisModule();
      const url = this.#options.url as string;
      owned = true;
      publisher = module.create(url);
      try {
        subscriber = module.create(url);
      } catch (error) {
        // The publisher is already live and no field references it yet, so this
        // is the only chance to close it.
        await this.#discard([publisher]);
        throw error;
      }
    }

    const listener = (channel: string, message: string): void => {
      if (channel !== this.#topic) {
        return;
      }
      this.#dispatch(message);
    };

    subscriber.on('message', listener);
    try {
      await subscriber.subscribe(this.#topic);
    } catch (error) {
      subscriber.off('message', listener);
      if (owned) {
        await this.#discard([subscriber, publisher]);
      }
      throw error;
    }

    this.#publisher = publisher;
    this.#subscriber = subscriber;
    this.#listener = listener;
  }

  /**
   * Quits connections abandoned by a failed open.
   *
   * @param clients - The connections to close
   */
  async #discard(clients: readonly IRedisBackplaneClient[]): Promise<void> {
    for (const client of clients) {
      try {
        await client.quit();
      } catch {
        // Best-effort: the open's own failure is what the caller needs to see,
        // so a rollback quit must not mask it.
        continue;
      }
    }
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
    // Drop the memoized open, or a connect() after this close would await the
    // already-resolved attempt and return without reconnecting.
    this.#opening = undefined;

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
    // Isolated per handler: this runs inside ioredis's `message` listener,
    // where a throw would be unhandled, and the WebSocket and SSE plugins share
    // this subscription so one must not starve the other.
    dispatchFrame(this.#handlers, parsed, (error) => {
      this.#handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
  }
}
