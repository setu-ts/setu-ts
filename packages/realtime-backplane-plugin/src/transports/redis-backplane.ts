/**
 * Redis pub/sub backplane transport.
 *
 * @module
 * @since 0.2.0
 */

import type { IRealtimeBackplane, RealtimeFrame, RealtimeFrameHandler } from '@setu-ts/common';
import type { IRedisBackplaneClient, RedisBackplaneOptions } from '../interfaces/index.ts';
import { DEFAULT_REDIS_COMMAND_TIMEOUT_MS } from '../interfaces/index.ts';

/**
 * The largest timer delay the runtimes honour (2^31 - 1 ms). A longer
 * `commandTimeout` does not mean "wait longer": the timer overflows and is set
 * to 1 ms, so every command would time out almost at once.
 */
const MAX_REDIS_COMMAND_TIMEOUT_MS = 2_147_483_647;
import { realtimeObserverOf } from '../diagnostics/realtime-observations.ts';
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
  /** The resolved per-command timeout; `0` means unbounded. */
  readonly #commandTimeoutMs: number;
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
   * Bumped by `close()`. An open attempt captures this on entry and compares
   * before publishing its connections, so a close that lands mid-attempt retires
   * them instead of letting them arrive on a closed backplane with nothing left
   * holding a reference to shut them down.
   */
  #generation = 0;

  /**
   * M70c: present only when both connections expose `status` and `ping`; the
   * indicator reads absence as *unknown* (a minimal fake that lacks the
   * surface has not told us the backend is dead). A subscriber-mode connection
   * refuses every command but (un)subscribe, so the pair is probed separately
   * (M47's two-connection requirement).
   *
   * @since 0.2.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param options - The Redis arm's options
   * @param origin - This instance's identity
   * @param topic - The Redis channel every instance shares
   * @throws {Error} When exactly one of `client` and `subscriber` is injected,
   * or when neither those nor a `url` is configured
   * @throws {RangeError} When `commandTimeoutMs` is not a number from `0` to
   * `2147483647` (the largest timer delay; beyond it the timer overflows to 1 ms)
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

    const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_REDIS_COMMAND_TIMEOUT_MS;
    // `NaN` (what `Number(env.X)` yields for an unset variable) would otherwise
    // reach ioredis and silently disable the bound this option exists for.
    if (
      typeof commandTimeoutMs !== 'number' || !Number.isFinite(commandTimeoutMs) ||
      commandTimeoutMs < 0 || commandTimeoutMs > MAX_REDIS_COMMAND_TIMEOUT_MS
    ) {
      // Fixed and value-free: the refused value is never echoed (it may be a
      // mis-assigned secret) and never converted, so no caller code runs here.
      throw new RangeError(
        'realtime-backplane: options.commandTimeoutMs must be a number from 0 to ' +
          `${MAX_REDIS_COMMAND_TIMEOUT_MS} (0 disables the bound)`,
      );
    }

    this.#options = options;
    this.#commandTimeoutMs = commandTimeoutMs;
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
   * so a later call retries. A `close()` arriving mid-attempt wins: the attempt
   * retires whatever it built rather than publishing it.
   *
   * @throws {Error} Whatever the module load, connection construction, or
   * SUBSCRIBE rejected with
   */
  async connect(): Promise<void> {
    const attempt = this.#opening ??= this.#open();
    try {
      await attempt;
    } catch (error) {
      // Only retract the attempt this call awaited. Clearing unconditionally
      // would let a late waiter on an old failure wipe a newer attempt's memo,
      // and the next connect() would then open a second, concurrent one.
      if (this.#opening === attempt) {
        this.#opening = undefined;
      }
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
    const generation = this.#generation;
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
      const clientOptions = this.#commandTimeoutMs === 0
        ? {}
        : { commandTimeout: this.#commandTimeoutMs };
      publisher = module.create(url, clientOptions);
      try {
        subscriber = module.create(url, clientOptions);
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

    if (generation !== this.#generation) {
      // A close() landed while this attempt was in flight. Publishing now would
      // hand two live connections to a closed backplane, where nothing holds a
      // reference to shut them down — so retire them here instead.
      subscriber.off('message', listener);
      await this.#unsubscribeQuietly(subscriber);
      if (owned) {
        await this.#discard([subscriber, publisher]);
      }
      return;
    }

    this.#publisher = publisher;
    this.#subscriber = subscriber;
    this.#listener = listener;
    this.#installProbe(publisher, subscriber);
  }

  /**
   * M70c: installs the two-connection probe when both connections expose the
   * `status`/`ping` surface; leaves `isHealthy` absent (unknown) otherwise.
   *
   * @param publisher - The publishing connection
   * @param subscriber - The subscriber-mode connection
   */
  #installProbe(publisher: IRedisBackplaneClient, subscriber: IRedisBackplaneClient): void {
    if (
      typeof publisher.ping !== 'function' ||
      typeof subscriber.ping !== 'function' ||
      publisher.status === undefined ||
      subscriber.status === undefined
    ) {
      delete this.isHealthy;
      return;
    }
    this.isHealthy = async (): Promise<boolean> => {
      // A subscriber-mode connection refuses every command but (un)subscribe,
      // so each half is checked on its own connection (M47).
      const halves = [publisher, subscriber];
      for (const client of halves) {
        if (client.status !== 'ready') {
          return false;
        }
        const ping = client.ping;
        if (typeof ping !== 'function') {
          return false;
        }
        try {
          // ioredis `ping` reads `this.options` — an unbound call throws
          // `TypeError: Cannot read properties of undefined (reading 'options')`
          // and the probe would report `false` forever against a healthy server.
          await ping.call(client);
        } catch {
          return false;
        }
      }
      return true;
    };
  }

  /**
   * Leaves the topic without letting a failure escape.
   *
   * @param subscriber - The connection to unsubscribe
   */
  async #unsubscribeQuietly(subscriber: IRedisBackplaneClient): Promise<void> {
    try {
      await subscriber.unsubscribe(this.#topic);
    } catch {
      // Best-effort: this runs only on the superseded-by-close path, where the
      // connection is being discarded anyway and there is no caller to inform.
      return;
    }
  }

  /**
   * Closes connections abandoned by a failed or superseded open, through the
   * same QUIT-then-`disconnect()` path as {@linkcode close}: a SUBSCRIBE that
   * timed out is usually followed by a QUIT that fails the same way, and
   * without the fallback those connections would keep reconnecting after
   * `connect()` had rejected.
   *
   * @param clients - The connections to close
   */
  async #discard(clients: readonly IRedisBackplaneClient[]): Promise<void> {
    // Best-effort: the open's own failure is what the caller needs to see, so
    // rollback failures are collected and dropped rather than rethrown.
    const ignored: unknown[] = [];
    for (const client of clients) {
      await this.#release(client, ignored);
    }
  }

  publish(frame: RealtimeFrame): Promise<void> {
    // M98l: counted as `backplane-publish` when observed. Completion means
    // `publish()` resolved, never that a peer received the frame.
    const observer = realtimeObserverOf(this);
    return observer === undefined
      ? this.#publish(frame)
      : observer.observePublish(() => this.#publish(frame));
  }

  /**
   * The publication itself, always on the publishing connection.
   *
   * Rejects when there is no connection — before `connect()` or after
   * `close()` — rather than resolving: a publish that reached nothing is a
   * failure the WebSocket and SSE consumers log and an observed publish
   * records, never a success.
   *
   * @throws {Error} When the transport is not connected
   */
  async #publish(frame: RealtimeFrame): Promise<void> {
    const publisher = this.#publisher;
    if (publisher === undefined) {
      throw new Error(
        'realtime-backplane: the redis transport is not connected (publish before ' +
          'connect() or after close()); the frame was not sent',
      );
    }
    // Always the publisher: the subscriber connection would reject this.
    await publisher.publish(this.#topic, JSON.stringify(frame));
  }

  subscribe(handler: RealtimeFrameHandler): Promise<() => void> {
    this.#handlers.add(handler);
    return Promise.resolve(() => {
      this.#handlers.delete(handler);
    });
  }

  /**
   * Leaves the topic and closes both connections. Every step is attempted even
   * when an earlier one fails; a connection whose QUIT fails is force-closed
   * through `disconnect()` when the client has one.
   *
   * @throws The first failure among UNSUBSCRIBE, QUIT and `disconnect()`,
   * after every connection has been released
   */
  async close(): Promise<void> {
    // Invalidate any open still in flight before reading the fields below: it
    // has not published its connections yet, so this is what tells it to retire
    // them rather than arrive after the shutdown.
    this.#generation++;
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
    // A closed backplane has no live connections to probe; report unknown.
    delete this.isHealthy;

    // Every step runs even when an earlier one fails. During an outage the
    // UNSUBSCRIBE and QUIT commands reject (the command timeout, or ioredis's
    // retry budget), and stopping at the first rejection left BOTH
    // connections reconnecting forever after the application had stopped.
    // The first failure is still reported, once everything is released.
    const failures: unknown[] = [];
    if (subscriber !== undefined) {
      if (listener !== undefined) {
        subscriber.off('message', listener);
      }
      try {
        await subscriber.unsubscribe(this.#topic);
      } catch (error) {
        failures.push(error);
      }
      await this.#release(subscriber, failures);
    }
    if (publisher !== undefined && publisher !== subscriber) {
      await this.#release(publisher, failures);
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  /**
   * Closes one connection: a graceful QUIT, and when that fails, a forced
   * `disconnect()`. The fallback is load-bearing: with `ioredis` a QUIT marks
   * the client as closing only when it is written to a live socket, so while
   * the server is unreachable the QUIT sits in the offline queue, is discarded
   * with it, and the client reconnects and re-subscribes once the server
   * returns (measured after a 25 s outage). Against a silent but connected
   * server, `disconnect()` also closes the socket at once rather than leaving
   * it open until the server answers. A client without `disconnect` is left
   * as QUIT left it.
   *
   * @param client - The connection to close
   * @param failures - Collects the QUIT failure, if any
   */
  async #release(client: IRedisBackplaneClient, failures: unknown[]): Promise<void> {
    try {
      await client.quit();
    } catch (error) {
      failures.push(error);
      try {
        client.disconnect?.();
      } catch (disconnectError) {
        failures.push(disconnectError);
      }
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
    const delivered = dispatchFrame(this.#handlers, parsed, (error) => {
      this.#handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    // M98l: counted only after the parse, shape and own-origin filters.
    realtimeObserverOf(this)?.observe('backplane-receive', delivered);
  }
}
