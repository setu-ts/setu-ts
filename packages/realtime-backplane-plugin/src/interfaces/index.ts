/**
 * Public option types and injection facades for the realtime backplane plugin.
 *
 * @module
 * @since 0.2.0
 */

import type { IRealtimeBackplane, RealtimeDiagnosticsOptions } from '@setu-ts/common';

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
  /**
   * M70c: resolves when this connection is alive. Optional so a minimal
   * injected fake still type-checks; the real `ioredis` client exposes it.
   *
   * @since 0.2.0
   */
  ping?(): Promise<unknown>;
  /**
   * M70c: the `ioredis` connection state (`'ready'` when usable). Optional for
   * the same reason as {@linkcode ping}.
   *
   * @since 0.2.0
   */
  readonly status?: string;
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
   * @param options - Client options the transport sets. `commandTimeout` is
   * the `ioredis` per-command timeout in milliseconds, present only when
   * {@linkcode RedisBackplaneOptions.commandTimeoutMs} is not `0`. Optional
   * so an existing caller and a module that ignores it both still type-check;
   * such a module's clients are unbounded. Passed by the transport since
   * 0.8.0.
   * @returns The client
   */
  create(url: string, options?: { readonly commandTimeout?: number }): IRedisBackplaneClient;
}

/**
 * Options shared by every transport arm.
 */
export interface BackplaneCommonOptions {
  /**
   * M70n X3-4: when the resolved transport is `'memory'`, the plugin logs a
   * process-local notice at `register()` — frames fan out only within this
   * process, which looks like partial delivery behind more than one replica.
   * Default `true`; `false` suppresses the notice, matching the existing
   * `scalingNotice` opt-out shape on the SSE and WebSocket plugins.
   *
   * @since 0.2.0
   */
  readonly localNotice?: boolean;
  /**
   * The broker topic / Redis channel every instance publishes and subscribes
   * on. Defaults to `'setu-ts.realtime'`. Instances must agree on it
   * to see each other.
   */
  readonly topic?: string;
  /**
   * This instance's identity, stamped on published frames so a subscriber can
   * drop its own echoes. Defaults to a fresh `runtime.uuid()`, which is
   * correct for every deployment; override only to make a test deterministic.
   */
  readonly origin?: string;
  /**
   * Opt-in realtime lifecycle observations for the local diagnostics
   * connector (M98l). Absent (the default) registers an inert `disabled`
   * source and observes nothing. Not available on the `'custom'` arm: an
   * application-supplied transport is never observed.
   *
   * When set, the plugin counts, under the one approved `alias`, how many
   * publications resolved or rejected (and how long the last took) and how
   * many arriving frames reached the local handlers, after the transport's
   * own shape and origin filters. Publication completion is transport
   * completion, never delivery to a peer. No frame, room or channel name,
   * payload or origin is ever observed. Validated when
   * `RealtimeBackplanePlugin(...)` is called.
   *
   * @since 0.8.0
   */
  readonly diagnostics?: RealtimeDiagnosticsOptions;
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
  /**
   * Bounds every command on the two connections this transport builds, in
   * milliseconds, through the `ioredis` `commandTimeout` option. Defaults to
   * {@linkcode DEFAULT_REDIS_COMMAND_TIMEOUT_MS}; `0` disables the bound.
   *
   * Without it, a connection that stays open while the server stops answering
   * (a paused or partitioned host that sends no reset) never settles a
   * publish: the caller's promise hangs, the WebSocket and SSE consumers never
   * log the failure, and an observed publish is never recorded. A
   * disconnected server is unaffected — `ioredis` already rejects its queued
   * commands when `maxRetriesPerRequest` exhausts (about 10 s on its default
   * backoff), which is below the default, so a short partition is still
   * buffered and delivered late.
   *
   * Read only on the lazy `npm:ioredis` path: an injected `client` /
   * `subscriber` pair keeps whatever timeout it was constructed with.
   *
   * @throws {RangeError} At construction, when not a finite number `>= 0`
   * @since 0.8.0
   */
  readonly commandTimeoutMs?: number;
}

/**
 * The default {@linkcode RedisBackplaneOptions.commandTimeoutMs}: above the
 * roughly 10 s `ioredis` spends retrying a disconnected server, so it bounds
 * only a connection that is open but silent.
 *
 * @since 0.8.0
 */
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 15_000;

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
export const DEFAULT_TOPIC = 'setu-ts.realtime';
