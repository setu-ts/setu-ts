/**
 * Redis pub/sub backplane transport.
 *
 * @module
 * @since 0.2.0
 */

import {
  BackendUnavailableError,
  dispatchRealtimeFrame,
  toBackendFault,
  watchConnection,
  withDeadline,
} from '@setu-ts/common';
import type { ConnectionWatch } from '@setu-ts/common';
import type {
  IRealtimeBackplane,
  IRealtimeHandlerErrorReporter,
  RealtimeFrame,
  RealtimeFrameHandler,
} from '@setu-ts/common';
import type { IRedisBackplaneClient, RedisBackplaneOptions } from '../interfaces/index.ts';
import { DEFAULT_REDIS_COMMAND_TIMEOUT_MS } from '../interfaces/index.ts';

/**
 * The largest timer delay the runtimes honour (2^31 - 1 ms). A longer
 * `commandTimeout` does not mean "wait longer": the timer overflows and is set
 * to 1 ms, so every command would time out almost at once.
 */
const MAX_REDIS_COMMAND_TIMEOUT_MS = 2_147_483_647;
import { realtimeObserverOf } from '../diagnostics/realtime-observations.ts';
import { createTransportHandlerReporter } from './handler-errors.ts';
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
  /** The most recent 100 errors thrown by subscribers during delivery, oldest first. */
  readonly #handlerErrors: Error[] = [];
  readonly #handlerReporter: IRealtimeHandlerErrorReporter;

  #publisher: IRedisBackplaneClient | undefined;
  #subscriber: IRedisBackplaneClient | undefined;
  /** Watches on the publisher (first) and subscriber; detached on close. */
  #watches: ConnectionWatch[] = [];
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
   * Ends an open's pending SUBSCRIBE (V12-53) or publisher-ready wait (M139f
   * audit L1) when `close()` lands. The two are sequential, so one field holds
   * whichever is in flight.
   */
  #openWait: AbortController | undefined;

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
   * @param reporter - Optional subscriber failure and recovery sink; history is always retained
   * @throws {Error} When exactly one of `client` and `subscriber` is injected,
   * or when neither those nor a `url` is configured
   * @throws {RangeError} When `commandTimeoutMs` is not a number from `0` to
   * `2147483647` (the largest timer delay; beyond it the timer overflows to 1 ms)
   */
  constructor(
    options: RedisBackplaneOptions,
    origin: string,
    topic: string,
    reporter?: IRealtimeHandlerErrorReporter,
  ) {
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
      typeof commandTimeoutMs !== 'number' ||
      !Number.isFinite(commandTimeoutMs) ||
      commandTimeoutMs < 0 ||
      commandTimeoutMs > MAX_REDIS_COMMAND_TIMEOUT_MS
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
    this.#handlerReporter = createTransportHandlerReporter(this.#handlerErrors, reporter);
  }

  /** The most recent 100 errors thrown by subscribers during delivery, oldest first. */
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
    const attempt = (this.#opening ??= this.#open());
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
    const reporter = this.#options.connectionErrorReporter;
    // Publisher first: its watch decides a lost-connection publish (X88-5).
    // Detached on every path that does not keep the connections.
    const watches: ConnectionWatch[] = [];
    const detachAll = (): void => {
      for (const watch of watches) watch.detach();
    };

    if (this.#options.client !== undefined && this.#options.subscriber !== undefined) {
      publisher = this.#options.client;
      subscriber = this.#options.subscriber;
      // One reporter for both: the pair fails together, so an outage's
      // identical errors from the two connections de-duplicate into one warn.
      // (M131a X88-3) an injected client's outages must be as visible as a
      // built one's; the attach is structural, so a client without `on` is
      // left alone.
      watches.push(watchConnection(publisher, reporter), watchConnection(subscriber, reporter));
      try {
        for (const client of [publisher, subscriber]) {
          if (client.status === 'wait' && typeof client.connect === 'function') {
            await client.connect();
          }
        }
      } catch (error) {
        // The injected pair stays the caller's; only our listeners come off (N-3).
        detachAll();
        throw error;
      }
    } else {
      const module = this.#options.module ?? (await loadRedisModule());
      const url = this.#options.url as string;
      owned = true;
      const clientOptions =
        this.#commandTimeoutMs === 0 ? {} : { commandTimeout: this.#commandTimeoutMs };
      // M139f X3-3: no offline queue on the publisher, so a frame published
      // while disconnected is refused at once (and warned about by the
      // consumer) instead of being held and delivered seconds late — or lost
      // anyway to the reconnect race. The subscriber keeps the default: it must
      // queue SUBSCRIBE until ready, and ioredis resubscribes it on reconnect.
      publisher = module.create(url, { ...clientOptions, enableOfflineQueue: false });
      watches.push(watchConnection(publisher, reporter));
      try {
        subscriber = module.create(url, clientOptions);
      } catch (error) {
        // The publisher is already live and no field references it yet, so this
        // is the only chance to close it.
        await this.#discard([publisher]);
        detachAll();
        throw error;
      }
      // One reporter for both: the pair fails together, so an outage's
      // identical errors from the two connections de-duplicate into one warn.
      watches.push(watchConnection(subscriber, reporter));
    }

    const listener = (channel: string, message: string): void => {
      if (channel !== this.#topic) {
        return;
      }
      this.#dispatch(message);
    };

    subscriber.on('message', listener);
    try {
      // V12-53: with `commandTimeoutMs: 0` a SUBSCRIBE to a host that never
      // answers would hold this open forever, so close() can cancel it; a
      // close() that already landed cancels it at once (as N2 does for the
      // ready wait below). With a bound the SUBSCRIBE settles within it, and
      // the generation check below retires the pair with UNSUBSCRIBE and QUIT.
      if (!(await this.#subscribe(subscriber, generation))) {
        // The host has not answered SUBSCRIBE, so it would not answer
        // UNSUBSCRIBE or QUIT either: force-close what we own, and leave an
        // injected pair to its owner with only our listeners removed.
        subscriber.off('message', listener);
        if (owned) forceClose([subscriber, publisher]);
        detachAll();
        return;
      }
      // A publisher without an offline queue refuses every command until it is
      // ready, so the pair is not handed out before then.
      // A close() that landed while SUBSCRIBE was in flight has already moved
      // the generation; the check below retires the pair, so do not start a
      // wait nothing can cancel (M139f re-audit N2).
      if (owned && generation === this.#generation) {
        const readyWait = new AbortController();
        this.#openWait = readyWait;
        try {
          await waitForReady(publisher, this.#commandTimeoutMs, readyWait.signal);
        } finally {
          if (this.#openWait === readyWait) this.#openWait = undefined;
        }
      }
    } catch (error) {
      subscriber.off('message', listener);
      // Detached only after the owned connections are discarded, as close()
      // does: their QUIT can emit an error that must still reach a listener
      // (CodeRabbit #543).
      if (owned) {
        await this.#discard([subscriber, publisher]);
      }
      detachAll();
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
      detachAll();
      return;
    }

    this.#publisher = publisher;
    this.#subscriber = subscriber;
    this.#listener = listener;
    this.#watches = watches;
    this.#installProbe(publisher, subscriber);
  }

  /**
   * Sends SUBSCRIBE; with `commandTimeoutMs: 0`, a `close()` cancels the wait
   * (V12-53).
   *
   * @param subscriber - The subscriber-mode connection
   * @param generation - The open attempt's generation
   * @returns `false` when `close()` cancelled the wait, `true` otherwise
   * @throws Whatever SUBSCRIBE rejected with, when it settles first
   */
  async #subscribe(subscriber: IRedisBackplaneClient, generation: number): Promise<boolean> {
    if (this.#commandTimeoutMs !== 0) {
      await subscriber.subscribe(this.#topic);
      return true;
    }
    const subscribeWait = new AbortController();
    this.#openWait = subscribeWait;
    if (generation !== this.#generation) subscribeWait.abort();
    try {
      return await settledUnlessCancelled(subscriber.subscribe(this.#topic), subscribeWait.signal);
    } finally {
      if (this.#openWait === subscribeWait) this.#openWait = undefined;
    }
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
    try {
      await publisher.publish(this.#topic, JSON.stringify(frame));
    } catch (error) {
      // M131a X88-5: a backend fault says whether the frame was applied.
      const fault = toBackendFault(error, 'realtime-backplane-plugin: redis transport');
      if (fault !== undefined) throw fault;
      throw error;
    }
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
    // A pending SUBSCRIBE or publisher-ready wait ends now, so the open retires
    // the pair — even with `commandTimeoutMs: 0` (V12-53, M139f audit L1).
    this.#openWait?.abort();
    this.#handlers.clear();
    const subscriber = this.#subscriber;
    const publisher = this.#publisher;
    const listener = this.#listener;
    this.#subscriber = undefined;
    this.#publisher = undefined;
    this.#listener = undefined;
    // Detached only after both connections are released (below): an ioredis
    // client with no 'error' listener prints QUIT's EPIPE on an unreachable
    // server to the console (M131a re-audit N-4).
    const watches = this.#watches;
    this.#watches = [];
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
    // A shared injected client must not report into this closed backplane.
    for (const watch of watches) watch.detach();
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
    const delivered = dispatchRealtimeFrame(this.#handlers, parsed, this.#handlerReporter);
    // M98l: counted only after the parse, shape and own-origin filters.
    realtimeObserverOf(this)?.observe('backplane-receive', delivered);
  }
}

/** The ioredis statuses of a connection that is on its way to `ready`. */
const CONNECTING_STATUSES: ReadonlySet<string> = new Set(['connecting', 'connect', 'reconnecting']);

/**
 * Waits for an owned publisher, created without an offline queue, to reach
 * `ready` (M139f X3-3).
 *
 * Only a client that is on its way to `ready` — ioredis's `connecting`,
 * `connect` or `reconnecting` — is waited on, for its first `'ready'` event,
 * bounded by `timeoutMs` (`0` is unbounded, as for `commandTimeoutMs`). Any
 * other status resolves at once: `ready`; no `status` at all (a custom
 * module's client cannot be observed); `wait`, which never becomes ready
 * unless something calls `connect()`; and `close`, whose publish then fails on
 * its own. An `end`ed publisher will never be ready, so it rejects — already
 * `end` when the wait would start, or emitting `'end'` during it. An aborted
 * `cancel` signal (a `close()`) also resolves the wait, so the open's
 * generation check retires the pair (M139f audit L1).
 *
 * @param client - The owned publisher
 * @param timeoutMs - The bound, in milliseconds
 * @param cancel - Aborted by `close()`
 * @returns Resolves once the client is ready, or once `cancel` is aborted
 * @throws {BackendUnavailableError} (as a rejection) when the bound passes
 *   first, or when the publisher is or becomes `end`
 */
function waitForReady(
  client: IRedisBackplaneClient,
  timeoutMs: number,
  cancel: AbortSignal,
): Promise<void> {
  const status = client.status;
  if (status === 'end') return Promise.reject(publisherEnded());
  if (status === undefined || !CONNECTING_STATUSES.has(status)) return Promise.resolve();
  return withDeadline(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        const detach = (): void => {
          client.off('ready', onReady);
          client.off('end', onEnd);
          cancel.removeEventListener('abort', onReady);
        };
        const onReady = (): void => {
          detach();
          resolve();
        };
        // A publisher whose retries are exhausted ends and never becomes ready:
        // fail the open now instead of waiting out the bound (or forever at 0).
        const onEnd = (): void => {
          detach();
          reject(publisherEnded());
        };
        client.on('ready', onReady);
        client.on('end', onEnd);
        signal.addEventListener('abort', detach, { once: true });
        cancel.addEventListener('abort', onReady, { once: true });
        // `withDeadline` runs this body a microtask later: a close() may already
        // have aborted `cancel` (M139f re-audit N3), and the status may have
        // moved since `waitForReady` read it.
        if (cancel.aborted || client.status === 'ready') onReady();
        else if (client.status === 'end') onEnd();
      }),
    {
      timeoutMs,
      onTimeout: () =>
        new BackendUnavailableError('realtime-backplane-plugin: redis transport', {
          cause: new Error(`the publisher was not ready within ${timeoutMs} ms`),
        }),
    },
  );
}

/**
 * The refusal for a publisher that ended before it was ready: its retries are
 * spent, so it never will be (M139f).
 *
 * @returns The error the open rejects with
 */
/**
 * Waits for `pending` unless `cancel` aborts first (V12-53).
 *
 * The abort listener is attached before `cancel.aborted` is read, so an abort
 * at any point wins. A rejection that arrives after the abort is handled here
 * (settling an already-settled promise is a no-op), so it never surfaces as an
 * unhandled rejection.
 *
 * @param pending - The command in flight
 * @param cancel - Aborted by `close()`
 * @returns `true` when `pending` resolved, `false` when `cancel` aborted first
 * @throws Whatever `pending` rejected with, when it settles first
 */
function settledUnlessCancelled(pending: Promise<unknown>, cancel: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = (): void => resolve(false);
    cancel.addEventListener('abort', onAbort, { once: true });
    pending.then(
      () => {
        cancel.removeEventListener('abort', onAbort);
        resolve(true);
      },
      (error: unknown) => {
        cancel.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (cancel.aborted) onAbort();
  });
}

/**
 * Closes connections at once, without the QUIT a host that never answered
 * SUBSCRIBE would not answer either (V12-53). `disconnect()` is ioredis's
 * synchronous close, which also rejects the pending SUBSCRIBE; a client
 * without it gets a QUIT that nothing waits on.
 *
 * @param clients - Connections this backplane built
 */
function forceClose(clients: readonly IRedisBackplaneClient[]): void {
  for (const client of clients) {
    try {
      if (typeof client.disconnect === 'function') client.disconnect();
      else client.quit().catch(() => undefined);
    } catch {
      // Best-effort: the backplane is closing and has no caller to inform.
    }
  }
}

function publisherEnded(): BackendUnavailableError {
  return new BackendUnavailableError('realtime-backplane-plugin: redis transport', {
    cause: new Error('the publisher connection ended before it was ready'),
  });
}
