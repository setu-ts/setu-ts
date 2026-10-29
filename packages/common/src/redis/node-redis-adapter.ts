/** Structural node-redis bridge for the seven Redis consumers. @module */
import { deadlineRangeError, withDeadline } from '../health/deadline.ts';
import { normalizeResp3 } from './resp3.ts';

/**
 * Single-node node-redis client surface used by {@link fromNodeRedis}.
 * No Redis package is loaded by this contract or its adapter.
 * @since 0.11.0
 */
export type NodeRedisClientLike = {
  /** Whether a connection is open or reconnecting. */
  readonly isOpen: boolean;
  /** Whether commands can currently reach Redis. */
  readonly isReady: boolean;
  /** Opens the client. */
  connect(): Promise<unknown>;
  /** Sends raw command arguments without node-redis's typed reply transforms. */
  sendCommand(args: readonly string[]): Promise<unknown>;
  /** Drains pending commands and closes the connection. */
  close(): Promise<unknown> | void;
  /** Immediately closes the connection. */
  destroy(): unknown;
  /** Registers an emitter listener. */
  on(
    event: string,
    listener: ((error: unknown) => void) | ((channel: string, message: string) => void),
  ): unknown;
  /** Removes an emitter listener. */
  off(
    event: string,
    listener: ((error: unknown) => void) | ((channel: string, message: string) => void),
  ): unknown;
  /** Subscribes using node-redis's message-first callback. */
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<unknown>;
  /** Stops listening to a channel. */
  unsubscribe(channel: string): Promise<unknown>;
};

/**
 * Bounds and error reporting for {@link fromNodeRedis}.
 * @since 0.11.0
 */
export type NodeRedisAdapterOptions = {
  /** Per-call bound, including connect and close. Default 15000 ms; 0 disables it. */
  readonly commandTimeoutMs?: number;
  /** Receives client error events; an absent callback leaves the required listener silent. */
  readonly onError?: (error: unknown) => void;
};

type Argument = string | number | undefined | readonly (string | number)[];
type MessageListener = (channel: string, message: string) => void;

/** The ioredis-shaped facade returned by {@link fromNodeRedis}. @since 0.11.0 */
export type NodeRedisAdapter = RedisAdapter;

/**
 * Wraps a single-node node-redis client for every Setu-TS Redis client option.
 * Commands connect lazily and normalize RESP3 maps into ioredis's raw arrays.
 * Each call is bounded independently; a timed-out command may still run on Redis.
 * The bound must exceed a streams consumer's blocking read duration.
 *
 * @param client - An application-created single-node client (RESP3 or RESP2)
 * @param options - Command bound and optional client error callback
 * @returns One adapter; use a separate wrapped duplicate for pub/sub
 * @throws {RangeError} If commandTimeoutMs is outside the finite timer range
 * @example
 * ```typescript
 * const client = fromNodeRedis(createClient({ url }), { commandTimeoutMs: 1000 });
 * await client.set('key', 'value', 'EX', 60);
 * await client.quit();
 * ```
 * @since 0.11.0
 */
export function fromNodeRedis(
  client: NodeRedisClientLike,
  options: NodeRedisAdapterOptions = {},
): NodeRedisAdapter {
  return new RedisAdapter(client, options);
}

class RedisAdapter {
  readonly #client: NodeRedisClientLike;
  readonly #timeoutMs: number;
  readonly #listeners = new Set<MessageListener>();
  #connecting: Promise<void> | undefined;
  #quitting: Promise<void> | undefined;
  #ended = false;
  /**
   * ONE dispatcher for every subscription: node-redis keeps a channel's
   * listeners in a Set, so re-subscribing a channel with the same function is a
   * no-op, as a repeated ioredis SUBSCRIBE is. A fresh closure per call would
   * deliver every message once per subscribe.
   */
  readonly #dispatch = (message: string, channel: string): void => {
    for (const listener of this.#listeners) listener(channel, message);
  };

  constructor(client: NodeRedisClientLike, options: NodeRedisAdapterOptions) {
    this.#timeoutMs = options.commandTimeoutMs === undefined ? 15_000 : options.commandTimeoutMs;
    const refusal = deadlineRangeError('commandTimeoutMs', this.#timeoutMs);
    if (refusal !== null) throw refusal;
    this.#client = client;
    // node-redis rethrows an unlistened 'error' event, so a listener is always
    // attached; a throwing onError must not throw out of the client's emit.
    client.on('error', (error: unknown) => {
      try {
        options.onError?.(error);
      } catch {
        // The application's handler failed; the error still surfaces through
        // the rejected command and health.
      }
    });
  }

  get status(): string {
    if (this.#ended) return 'end';
    if (this.#client.isReady) return 'ready';
    return this.#client.isOpen || this.#connecting !== undefined ? 'connecting' : 'wait';
  }

  #bound<T>(run: () => Promise<T>): Promise<T> {
    return withDeadline(run, {
      timeoutMs: this.#timeoutMs,
      onTimeout: () => new Error('Command timed out'),
    });
  }

  connect(): Promise<void> {
    if (this.#ended) return Promise.reject(new Error('The client is closed'));
    if (this.#connecting !== undefined) return this.#connecting;
    if (this.#client.isOpen) return Promise.resolve();
    this.#connecting = this.#bound(async () => {
      await this.#client.connect();
    }).finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  #command<T>(command: string, args: readonly Argument[]): Promise<T> {
    return this.#bound(async () => {
      await this.connect();
      const flattened = args.flatMap((arg) =>
        arg === undefined ? [] : typeof arg === 'object' ? arg.map(String) : [String(arg)],
      );
      const reply = await this.#client.sendCommand([command, ...flattened]);
      // Facade return types describe Redis's command contract, as for ioredis.
      return normalizeResp3(reply, command) as T;
    });
  }

  quit(): Promise<void> {
    if (this.#quitting !== undefined) return this.#quitting;
    this.#ended = true;
    if (!this.#client.isOpen) return Promise.resolve();
    this.#quitting = this.#bound(async () => {
      await this.#client.close();
    }).catch((error: unknown) => {
      this.#destroy();
      if (!(error instanceof Error && error.message === 'Command timed out')) throw error;
    });
    return this.#quitting;
  }

  disconnect(): void {
    this.#ended = true;
    this.#destroy();
  }

  /**
   * Destroys the client, best effort: node-redis 5 throws `ClientClosedError`
   * from `destroy()` on a client that is already closed (6 returns), and the
   * backplane's close path calls `disconnect()` after `quit()`.
   */
  #destroy(): void {
    try {
      this.#client.destroy();
    } catch {
      // Already closed: nothing left to tear down.
    }
  }

  subscribe(channel: string): Promise<unknown> {
    return this.#bound(async () => {
      await this.connect();
      return this.#client.subscribe(channel, this.#dispatch);
    });
  }

  unsubscribe(channel: string): Promise<unknown> {
    return this.#bound(async () => {
      await this.connect();
      return this.#client.unsubscribe(channel);
    });
  }

  on(event: string, listener: MessageListener): void {
    if (event === 'message') this.#listeners.add(listener);
    else this.#client.on(event, listener);
  }

  off(event: string, listener: MessageListener): void {
    if (event === 'message') this.#listeners.delete(listener);
    else this.#client.off(event, listener);
  }

  /** Sends GET with ioredis positional arguments. */
  get(...args: Argument[]): Promise<string | null> {
    return this.#command('GET', args);
  }

  /** Sends SET with ioredis positional arguments. */
  set(...args: Argument[]): Promise<string | null> {
    return this.#command('SET', args);
  }

  /** Sends DEL with ioredis positional arguments. */
  del(...args: Argument[]): Promise<number> {
    return this.#command('DEL', args);
  }

  /** Sends EXISTS with ioredis positional arguments. */
  exists(...args: Argument[]): Promise<number> {
    return this.#command('EXISTS', args);
  }

  /** Sends PING with ioredis positional arguments. */
  ping(...args: Argument[]): Promise<string> {
    return this.#command('PING', args);
  }

  /** Sends SCAN with ioredis positional arguments. */
  scan(...args: Argument[]): Promise<[string, string[]]> {
    return this.#command('SCAN', args);
  }

  /** Sends ZADD with ioredis positional arguments. */
  zadd(...args: Argument[]): Promise<number> {
    return this.#command('ZADD', args);
  }

  /** Sends ZRANGEBYSCORE with ioredis positional arguments. */
  zrangebyscore(...args: Argument[]): Promise<string[]> {
    return this.#command('ZRANGEBYSCORE', args);
  }

  /** Sends ZREM with ioredis positional arguments. */
  zrem(...args: Argument[]): Promise<number> {
    return this.#command('ZREM', args);
  }

  /** Sends HSET with ioredis positional arguments. */
  hset(...args: Argument[]): Promise<number> {
    return this.#command('HSET', args);
  }

  /** Sends HGET with ioredis positional arguments. */
  hget(...args: Argument[]): Promise<string | null> {
    return this.#command('HGET', args);
  }

  /** Sends HDEL with ioredis positional arguments. */
  hdel(...args: Argument[]): Promise<number> {
    return this.#command('HDEL', args);
  }

  /** Sends ZCARD with ioredis positional arguments. */
  zcard(...args: Argument[]): Promise<number> {
    return this.#command('ZCARD', args);
  }

  /** Sends EXPIRE with ioredis positional arguments. */
  expire(...args: Argument[]): Promise<number> {
    return this.#command('EXPIRE', args);
  }

  /** Sends EVAL with ioredis positional arguments. */
  readonly eval = (...args: Argument[]): Promise<unknown> => this.#command('EVAL', args);

  /** Sends XADD with ioredis positional arguments. */
  xadd(...args: Argument[]): Promise<string> {
    return this.#command('XADD', args);
  }

  /** Sends XGROUP with ioredis positional arguments. */
  xgroup(...args: Argument[]): Promise<string | number> {
    return this.#command('XGROUP', args);
  }

  /** Sends XREADGROUP with ioredis positional arguments. */
  xreadgroup(...args: Argument[]): Promise<unknown[][] | null> {
    return this.#command('XREADGROUP', args);
  }

  /** Sends XPENDING with ioredis positional arguments. */
  xpending(...args: Argument[]): Promise<Array<[string, string, number, number]>> {
    return this.#command('XPENDING', args);
  }

  /** Sends XCLAIM with ioredis positional arguments. */
  xclaim(...args: Argument[]): Promise<Array<[string, string[]] | null>> {
    return this.#command('XCLAIM', args);
  }

  /** Sends XINFO with ioredis positional arguments. */
  xinfo(...args: Argument[]): Promise<unknown[][]> {
    return this.#command('XINFO', args);
  }

  /** Sends XACK with ioredis positional arguments. */
  xack(...args: Argument[]): Promise<number> {
    return this.#command('XACK', args);
  }

  /** Sends PUBLISH with ioredis positional arguments. */
  publish(...args: Argument[]): Promise<number> {
    return this.#command('PUBLISH', args);
  }

  /** Sends INCR with ioredis positional arguments. */
  incr(...args: Argument[]): Promise<number> {
    return this.#command('INCR', args);
  }

  /** Sends PEXPIRE with ioredis positional arguments. */
  pexpire(...args: Argument[]): Promise<number> {
    return this.#command('PEXPIRE', args);
  }

  /** Sends PTTL with ioredis positional arguments. */
  pttl(...args: Argument[]): Promise<number> {
    return this.#command('PTTL', args);
  }

  /** Sends an arbitrary raw Redis command with the same normalization and bound. */
  call(command: string, ...args: Argument[]): Promise<unknown> {
    return this.#command(command.toUpperCase(), args);
  }
}
