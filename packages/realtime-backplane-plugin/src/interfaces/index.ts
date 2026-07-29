/**
 * Public option types and injection facades for the realtime backplane plugin.
 *
 * @module
 * @since 0.2.0
 */

import type { IRealtimeBackplane } from '@hono-enterprise/common';

/**
 * The `ioredis`-shaped client surface the Redis transport uses.
 *
 * Declared structurally so `ioredis` is never a hard dependency (§12.2) and an
 * application may inject any compatible client.
 *
 * @since 0.2.0
 */
export interface IRedisBackplaneClient {
  /**
   * Publishes a message to a channel.
   *
   * @param channel - The channel name
   * @param message - The message payload
   * @returns The number of subscribers that received it
   */
  publish(channel: string, message: string): Promise<number>;
  /**
   * Subscribes to a channel.
   *
   * @param channel - The channel name
   * @returns The number of channels this connection is now subscribed to
   */
  subscribe(channel: string): Promise<unknown>;
  /**
   * Unsubscribes from a channel.
   *
   * @param channel - The channel name
   */
  unsubscribe(channel: string): Promise<unknown>;
  /**
   * Registers an event listener. The transport listens for `'message'`.
   *
   * @param event - The event name
   * @param listener - Invoked with the channel and the raw message
   */
  on(event: string, listener: (channel: string, message: string) => void): void;
  /**
   * Removes a previously registered listener.
   *
   * @param event - The event name
   * @param listener - The listener to remove
   */
  off(event: string, listener: (channel: string, message: string) => void): void;
  /** Closes the connection. */
  quit(): Promise<unknown>;
}

/**
 * A module exposing an `ioredis`-compatible constructor.
 *
 * @since 0.2.0
 */
export interface IRedisModule {
  /**
   * Constructs a client.
   *
   * @param url - The Redis connection URL
   * @returns The client
   */
  create(url: string): IRedisBackplaneClient;
}

/** Options shared by every transport arm. */
export interface BackplaneCommonOptions {
  /**
   * The broker topic / Redis channel every instance publishes and subscribes
   * on. Defaults to `'hono-enterprise.realtime'`. Instances must agree on it
   * to see each other.
   */
  readonly topic?: string;
  /**
   * This instance's identity, stamped on published frames so a subscriber can
   * drop its own echoes. Defaults to a fresh `runtime.uuid()`, which is
   * correct for every deployment; override only to make a test deterministic.
   */
  readonly origin?: string;
}

/**
 * Options for the `'memory'` arm — a real single-process transport, not a
 * no-op. Instances sharing one process see each other; separate processes do
 * not.
 *
 * @since 0.2.0
 */
export interface MemoryBackplaneOptions extends BackplaneCommonOptions {
  /** Transport discriminant. */
  transport?: 'memory';
  /**
   * The name of the process-wide bus this instance joins. Two backplanes built
   * with the same name exchange frames; different names are isolated, which is
   * what keeps concurrent tests from bleeding into each other.
   * Defaults to `'default'`.
   */
  readonly bus?: string;
}

/**
 * Options for the `'messaging'` arm, which carries frames over whatever broker
 * is registered under `CAPABILITIES.MESSAGING`.
 *
 * @since 0.2.0
 */
export interface MessagingBackplaneOptions extends BackplaneCommonOptions {
  /** Transport discriminant. */
  transport: 'messaging';
}

/**
 * Options for the `'redis'` arm — Redis pub/sub.
 *
 * @since 0.2.0
 */
export interface RedisBackplaneOptions extends BackplaneCommonOptions {
  /** Transport discriminant. */
  transport: 'redis';
  /**
   * The publishing client. Must be supplied together with
   * {@linkcode RedisBackplaneOptions.subscriber}: a Redis connection in
   * subscriber mode refuses every other command, so one connection cannot do
   * both jobs.
   */
  readonly client?: IRedisBackplaneClient;
  /** The dedicated subscriber client. */
  readonly subscriber?: IRedisBackplaneClient;
  /**
   * Connection URL used to build both clients on the lazy `npm:ioredis` path.
   * Read only when no clients are injected.
   */
  readonly url?: string;
  /** A module exposing an `ioredis`-compatible constructor, for testing. */
  readonly module?: IRedisModule;
}

/**
 * Options for the `'custom'` arm — a caller-supplied transport.
 *
 * @since 0.2.0
 */
export interface CustomBackplaneOptions {
  /** Transport discriminant. */
  transport: 'custom';
  /** The transport to register, used as-is. */
  readonly instance: IRealtimeBackplane;
}

/**
 * Options for {@linkcode RealtimeBackplanePlugin}, discriminated on
 * `transport`.
 *
 * @since 0.2.0
 */
export type RealtimeBackplanePluginOptions =
  | MemoryBackplaneOptions
  | MessagingBackplaneOptions
  | RedisBackplaneOptions
  | CustomBackplaneOptions;

/** The default topic when none is configured. */
export const DEFAULT_TOPIC = 'hono-enterprise.realtime';
