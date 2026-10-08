import type {
  ISubscription,
  MessageHandler,
  MessageMetadata,
  PublishOptions,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import { createCachedProbe, deadlineRangeError, withDeadline } from '@setu-ts/common';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { describeError, describeLogText } from './describe-error.ts';
import { IntegrationEventRejectedError } from '../errors.ts';
import { normalizeTransportHeaders, type TransportHeaderValue } from './header-normalize.ts';
import { buildTransportHeaders, validatePublishOptions } from './publish-options.ts';
import { createTopicInbox, type InternalSubscribeOptions, REPLY_INBOX_TRANSIENT } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { ReconnectSupervisor } from './reconnect.ts';
import type { IAmqpConnection, RabbitMqOptions } from '../interfaces/index.ts';
// amqplib's frame codec requires a Node Buffer for message content (it throws
// `TypeError('content is not a buffer')` for a string or a Uint8Array). This is
// the sanctioned cross-runtime static `node:` import (Deno/Node/Bun all support
// it); there is no web-standard value amqplib's wire protocol accepts.
import { Buffer } from 'node:buffer';

/**
 * Lazily load amqplib at runtime.
 *
 * @returns The amqplib module
 * @throws {Error} If the npm:amqplib package cannot be resolved
 */
async function loadAmqplib(): Promise<typeof import('npm:amqplib@0.10.x')> {
  const mod = await import('npm:amqplib@0.10.x');
  return mod;
}

/**
 * Structural validation for AMQP connection.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IAmqpConnection {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['createChannel', 'close'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/** Default bound on one publish, including its confirm, in ms. */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 15_000;

/**
 * Resolves and validates `publishTimeoutMs`. Shared by
 * `MessagingPlugin(...)` (which refuses a bad value at construction) and the
 * broker constructor, so both read one rule.
 *
 * @param value - The configured bound, or `undefined` for the default
 * @returns The bound in milliseconds (`0` = unbounded)
 * @throws {RangeError} When the value is outside `0`–`2147483647` or not finite
 */
export function resolvePublishTimeoutMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const refusal = deadlineRangeError('messaging-plugin: publishTimeoutMs', resolved);
  if (refusal !== null) {
    throw refusal;
  }
  return resolved;
}

/** Resolved immutable consumer configuration shared by plugin and broker construction. */
interface ConsumerOptions {
  readonly retry: boolean;
  readonly maxAttempts: number;
  readonly delaysMs: readonly number[];
  readonly isRetryable: ((error: unknown) => boolean) | undefined;
  readonly deadLetterMaxLength: number;
  readonly prefetch: number;
}

/**
 * Validates all consumer options before any connection is opened.
 * @param options - RabbitMQ consumer configuration
 * @returns A snapshot of the validated configuration
 * @throws {RangeError} For invalid budgets, delays, retention, or prefetch
 */
export function resolveConsumerOptions(options: RabbitMqOptions = {}): ConsumerOptions {
  const retry = options.consumerRetry;
  if (retry !== undefined && retry !== false && (retry === null || typeof retry !== 'object')) {
    throw new RangeError('RabbitMqBroker consumerRetry must be false or an options object');
  }
  const configured = retry === false ? undefined : retry;
  const maxAttempts = configured?.maxAttempts ?? 5;
  const delaysMs = [...(configured?.delaysMs ?? [5000, 30000, 120000, 600000])];
  const deadLetterMaxLength = options.deadLetterMaxLength ?? 10000;
  const prefetch = options.prefetch ?? 32;
  const positive = (name: string, value: number, max = Number.MAX_SAFE_INTEGER): void => {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new RangeError(`RabbitMqBroker ${name} must be a positive integer within its bound`);
    }
  };
  positive('consumerRetry.maxAttempts', maxAttempts);
  positive('deadLetterMaxLength', deadLetterMaxLength);
  // AMQP basic.qos encodes prefetch-count as an unsigned short.
  positive('prefetch', prefetch, 65535);
  if (delaysMs.length === 0) {
    throw new RangeError('RabbitMqBroker consumerRetry.delaysMs must be nonempty');
  }
  for (const [index, delay] of delaysMs.entries()) {
    positive('consumerRetry.delaysMs', delay, 2147483647);
    if (index > 0 && delay < delaysMs[index - 1]!) {
      throw new RangeError('RabbitMqBroker consumerRetry.delaysMs must be nondecreasing');
    }
  }
  if (configured?.isRetryable !== undefined && typeof configured.isRetryable !== 'function') {
    throw new RangeError('RabbitMqBroker consumerRetry.isRetryable must be a function');
  }
  return {
    retry: retry !== false,
    maxAttempts,
    delaysMs,
    isRetryable: configured?.isRetryable,
    deadLetterMaxLength,
    prefetch,
  };
}

/** Refuses group names that occupy the retry topology's reserved namespace. */
export function validateConsumerQueue(
  queue: string | undefined,
  policy: Pick<ConsumerOptions, 'retry' | 'delaysMs'>,
  transient = false,
): void {
  if (queue === undefined || !policy.retry || transient) return;
  if (/(?:\.dead|\.retry\.\d+ms)$/u.test(queue)) {
    throw new RangeError(
      'RabbitMQ consumer group names ending in .dead or .retry.<digits>ms are reserved; ' +
        'rename the group or set consumerRetry: false',
    );
  }
  const longest = `${queue}.retry.${policy.delaysMs[policy.delaysMs.length - 1]}ms`;
  if (new TextEncoder().encode(longest).length > 255) {
    throw new RangeError('RabbitMQ consumer group and helper queue names must fit 255 UTF-8 bytes');
  }
}

/**
 * Names the first publish field AMQP cannot encode, or `null` when all fit.
 *
 * AMQP writes the exchange, the routing key, `messageId` and every header-table
 * key as a short string of at most 255 UTF-8 bytes. amqplib's
 * `ConfirmChannel.publish` queues its confirm callback BEFORE encoding, so an
 * encoder throw leaves an orphan in the confirm window and every later confirm
 * on the channel resolves the wrong publish (M106 audit F1). Checking first
 * means `publish` is never called with a frame it cannot write.
 *
 * @param exchange - Exchange name
 * @param routingKey - Routing key (the topic)
 * @param properties - Publish properties
 * @returns A field description, or `null`
 */
function amqpShortStringProblem(
  exchange: string,
  routingKey: string,
  properties: Record<string, unknown>,
): string | null {
  const encoder = new TextEncoder();
  const fits = (value: string): boolean => encoder.encode(value).length <= 255;
  if (!fits(exchange)) return 'exchange name';
  if (!fits(routingKey)) return 'routing key (the topic)';
  const messageId = properties.messageId;
  if (typeof messageId === 'string' && !fits(messageId)) return 'message id';
  const headers = properties.headers;
  if (typeof headers === 'object' && headers !== null) {
    for (const name of Object.keys(headers)) {
      if (!fits(name)) return 'a header name';
    }
  }
  return null;
}

/** Framework-owned identifier for correlating concurrent mandatory publish returns. */
const DISPOSITION_ID = 'x-setu-disposition-id';

/** Error description bounded to 1 KiB of UTF-8, without splitting a code point. */
function deadLetterError(error: unknown): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = '';
  for (const character of describeError(error)) {
    bytes += encoder.encode(character).length;
    if (bytes > 1024) break;
    result += character;
  }
  return result;
}

/**
 * The publish signature of an amqplib channel. On a confirm channel the fifth
 * argument is called once the broker has accepted (`null`) or refused (an
 * error) the message; a channel that closes first calls it with an error.
 */
interface PublishingChannel {
  publish(
    exchange: string,
    routingKey: string,
    content: Uint8Array,
    properties?: unknown,
    confirm?: (err: unknown) => void,
  ): boolean;
}

/**
 * The close-listener members of an amqplib channel (an `EventEmitter`). Read
 * structurally, so an injected facade without them still publishes; it then
 * relies on `publishTimeoutMs` alone to settle a confirm that never arrives.
 */
interface CloseObservable {
  on(event: 'close' | 'return', listener: (message?: unknown) => void): unknown;
  off(event: 'close' | 'return', listener: (message?: unknown) => void): unknown;
}

/**
 * Whether a channel exposes the `on`/`off` pair a per-publish close listener
 * needs.
 *
 * @param channel - The channel to inspect
 * @returns `true` when both members are functions
 */
function isCloseObservable(channel: unknown): channel is CloseObservable {
  return typeof channel === 'object' && channel !== null &&
    typeof (channel as { on?: unknown }).on === 'function' &&
    typeof (channel as { off?: unknown }).off === 'function';
}

/**
 * Publishes on a confirm channel and settles on the broker's answer.
 *
 * amqplib throws SYNCHRONOUSLY when the channel is already closed (probed);
 * the executor turns that into a rejection, so the returned promise is the
 * only failure channel.
 *
 * The promise ALSO rejects when the channel closes before the confirm
 * arrives. amqplib 0.10.x drains its unconfirmed callbacks on close, but the
 * drain stops at the first slot an out-of-order confirm already settled, so
 * a later callback can never run — and with `publishTimeoutMs: 0` nothing
 * else would settle the publish. The listener is removed once the publish
 * settles either way, so a long-lived channel accumulates none.
 *
 * @param channel - The confirm channel
 * @param exchange - Target exchange
 * @param routingKey - Routing key
 * @param content - Message body
 * @param properties - Publish properties
 * @param dispositionId - Framework ID of a mandatory retry/dead copy, when routing is required
 * @param signal - Deadline cancellation for a disposition
 * @returns Resolves once RabbitMQ accepts the message
 */
function publishConfirmed(
  channel: PublishingChannel,
  exchange: string,
  routingKey: string,
  content: Uint8Array,
  properties: Record<string, unknown>,
  dispositionId?: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const observable = isCloseObservable(channel) ? channel : null;
    let settled = false;
    const settle = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      observable?.off('close', onClose);
      if (dispositionId !== undefined) observable?.off('return', onReturn);
      signal?.removeEventListener('abort', onAbort);
      if (err === null || err === undefined) {
        resolve();
        return;
      }
      reject(
        new Error(
          `RabbitMQ did not confirm the message published to exchange "${exchange}" ` +
            `with routing key "${routingKey}": ${describeError(err)}`,
          { cause: err },
        ),
      );
    };
    const onClose = (): void => settle(new Error('channel closed before the confirm arrived'));
    const onAbort = (): void => settle(signal?.reason);
    const onReturn = (message: unknown): void => {
      // amqplib decodes basic.return into the same message shape as a delivery.
      // Only our own publish ID can reject this operation; routing keys and
      // message IDs can be identical for several in-flight copies.
      try {
        const returned = message as { properties?: { headers?: Record<string, unknown> } } | null;
        const headers = returned?.properties?.headers;
        if (
          headers && Object.hasOwn(headers, DISPOSITION_ID) &&
          headers[DISPOSITION_ID] === dispositionId
        ) {
          settle(new Error('mandatory disposition publish was returned as unroutable'));
        }
      } catch {
        settle(new Error('RabbitMQ supplied an invalid publish return'));
      }
    };
    observable?.on('close', onClose);
    if (dispositionId !== undefined) observable?.on('return', onReturn);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      channel.publish(exchange, routingKey, content, properties, settle);
    } catch (error) {
      settled = true;
      observable?.off('close', onClose);
      if (dispositionId !== undefined) observable?.off('return', onReturn);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}

/** Reachability-probe cache lifetime (M95b review), in ms. */
const PROBE_TTL_MS = 5000;

/** Per-probe timeout (M95b review), in ms. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Structural check for the one member the reachability probe needs off a
 * fresh channel (M95b §3.6): `close(): Promise<void>`. The probe closes its
 * throwaway channel through this check rather than a cast, and a channel
 * without it is skipped rather than forced.
 */
function isCloseableChannel(value: unknown): value is { close(): Promise<void> } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { close?: unknown }).close === 'function';
}

/**
 * Resolve the AMQP connection: prefer injected client, then lazy-load amqplib.
 *
 * @param url - RabbitMQ connection URL
 * @param injectedClient - Optionally injected AMQP connection
 * @returns The resolved connection
 * @throws {Error} If no client injected and amqplib cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient?: IAmqpConnection,
): Promise<IAmqpConnection> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected AMQP client does not match the required structural shape ' +
          '(needs: createChannel, close)',
      );
    }
    return injectedClient;
  }
  const amqplib = await loadAmqplib();
  const connection = await amqplib.connect(url);
  return connection as unknown as IAmqpConnection;
}

/**
 * Internal subscriber entry, kept as a *specification* (topic + handler +
 * queue) rather than a live channel handle. M70c: after a broker restart the
 * old channel is dead, so replay re-derives the consumer on the fresh
 * channel from this spec.
 */
interface ActiveConsumer {
  id: string;
  topic: string;
  handler: MessageHandler<unknown>;
  queue: string | undefined; // undefined means exclusive server-named queue
  /**
   * The `assertQueue` declaration this subscription's shape demands —
   * durable for a caller-supplied consumer-group queue, transient for a
   * private per-subscriber one. Carried on the spec so the drive-mode
   * replay re-asserts the SAME shape on the fresh channel (RabbitMQ 4
   * refuses a re-declaration that disagrees with the existing queue).
   */
  declareOptions: QueueDeclareOptions;
  consumerTag: string;
  channel: unknown;
}

/**
 * The two queue shapes this broker declares. RabbitMQ 4 refuses the previous
 * unconditional `{ durable: false }` for a DURABLE-adjacent named queue and
 * equally refuses `{ durable: true }` re-applied with different properties,
 * so the shape is computed once at subscribe time and reused verbatim.
 */
type QueueDeclareOptions =
  | { readonly durable: true }
  | { readonly exclusive: true; readonly autoDelete: true };

/**
 * RabbitMQ message broker implementation using AMQP 0-9-1 topic exchange.
 *
 * M70c: amqplib has no reconnect of any kind, so this broker runs the
 * {@linkcode ReconnectSupervisor} in **drive** mode — on a connection
 * `'error'`/`'close'` event it reconnects, re-asserts the exchange, and
 * replays every active subscription. `isReady()` keeps its lifecycle meaning
 * (a reconnecting broker is still ready); `reachability()` reports the
 * fault window, which the health indicator maps to `down`.
 *
 * @since 0.1.0
 */
export class RabbitMqBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #url: string;
  #injectedClient: IAmqpConnection | undefined;
  #exchangeName: string;
  #defaultQueue: string;
  #persistentMessages: boolean;
  #publishTimeoutMs: number;
  #consumerOptions: ConsumerOptions;
  #logger?: { error: (msg: string) => void; warn?: (msg: string) => void };
  #connection: IAmqpConnection | null = null;
  #channel: unknown | null = null;
  /**
   * Whether `#channel` is a confirm channel. Set by the ONE channel factory,
   * {@linkcode RabbitMqBroker.#createChannel}, so the drive-mode reconnect
   * cannot silently fall back to unconfirmed publishing.
   */
  #confirmed = false;
  /** Whether the no-confirm-channel warning has been logged (once per broker). */
  #warnedUnconfirmed = false;
  #ready = false;
  #activeConsumers: Map<string, ActiveConsumer>;
  #rr: RequestReplyCore;
  #supervisor: ReconnectSupervisor;
  /** Channels a failed disposition is already closing (one close each). */
  #closingChannels = new WeakSet<object>();
  /**
   * The cached, bounded reachability probe (M95b review), built at
   * `connect()` and dropped at `disconnect()`.
   *
   * The bound lives HERE rather than only at the health indicator, because
   * the indicator is not the only caller: `realtime-backplane-plugin`'s
   * `'messaging'` transport delegates straight to `broker.isHealthy()`
   * (`transports/messaging-backplane.ts`) and documents that it deliberately
   * adds no cache of its own, "retaining the resolved broker's own probe
   * cache". That held while this probe was a flag read; once §3.6 made it a
   * real AMQP round trip it meant one channel open per health poll, and a
   * HUNG broker — the `docker pause` condition X51-2 exists for — left that
   * indicator to hit `HealthPlugin`'s `indicatorTimeoutMs` and report `down`,
   * taking `/ready` to 503 for a fan-out failure its own contract says is
   * `degraded` at worst. Caching in the broker is what makes the backplane's
   * documented assumption true again, for every caller at once.
   */
  #probe: (() => Promise<boolean | undefined>) | null = null;

  /**
   * Creates a new RabbitMQ broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   * @param options - RabbitMQ connection and configuration options
   */
  constructor(
    runtime: IRuntimeServices,
    serializer: ISerializer,
    options?: RabbitMqOptions,
  ) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#url = options?.url ?? 'amqp://localhost:5672';
    this.#injectedClient = options?.client;
    this.#exchangeName = options?.exchangeName ?? 'messaging';
    this.#defaultQueue = options?.defaultQueue ?? 'messaging-consumers';
    this.#persistentMessages = options?.persistentMessages ?? true;
    this.#publishTimeoutMs = resolvePublishTimeoutMs(
      options?.publishTimeoutMs,
    );
    this.#consumerOptions = resolveConsumerOptions(options);
    if (options?.logger) {
      this.#logger = options.logger;
    }
    this.#activeConsumers = new Map();
    this.#rr = new RequestReplyCore({
      publish: (topic, message, headers) => this.publishWithHeaders(topic, message, headers ?? {}),
      subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
      uuid: () => this.#runtime.uuid(),
      setTimeout: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => this.#runtime.clearTimeout(handle),
      openInbox: createTopicInbox({
        subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
        uuid: () => this.#runtime.uuid(),
      }),
    });
    this.#supervisor = new ReconnectSupervisor({
      runtime,
      mode: 'drive',
      reconnect: () => this.#reconnect(),
      reassert: () => this.#reassertExchange(),
      replay: () => this.#replayConsumers(),
      attachFaultListener: (onFault) => this.#attachFaultListeners(onFault),
    });
  }

  /**
   * Connects to RabbitMQ.
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    this.#connection = await resolveClient(this.#url, this.#injectedClient);
    this.#channel = await this.#createChannel();
    await this.#reassertExchange();
    this.#probe = createCachedProbe<boolean | undefined>({
      probe: () => this.#openThrowawayChannel(),
      // A probe that could not answer inside the bound has told us nothing,
      // not that the broker is gone — the V5-2 rule. `false` (the helper's
      // default) would report a hung broker as positively unreachable.
      fallback: undefined,
      ttlMs: PROBE_TTL_MS,
      timeoutMs: PROBE_TIMEOUT_MS,
      hrtime: this.#runtime.hrtime.bind(this.#runtime),
      setTimer: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimer: (handle) => this.#runtime.clearTimeout(handle),
    });
    this.#ready = true;
    this.#supervisor.start();
  }

  /**
   * Disconnects from RabbitMQ.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  async disconnect(): Promise<void> {
    this.#supervisor.stop();
    await this.#rr.close();
    // Close all active consumers
    for (const consumer of this.#activeConsumers.values()) {
      try {
        const realChannel = consumer.channel as unknown as { cancel(tag: string): Promise<void> };
        await realChannel.cancel(consumer.consumerTag);
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.#activeConsumers.clear();
    this.#channel = null;
    if (this.#connection && !this.#injectedClient) {
      try {
        await (this.#connection as unknown as { close(): Promise<void> }).close();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.#connection = null;
    // Drop the cached probe WITH the connection (the M90b Service Bus rule):
    // a surviving cache would serve a stale `true` inside its TTL for a
    // broker that no longer exists, and then fire real I/O at a closed one.
    this.#probe = null;
    this.#ready = false;
  }

  /**
   * Checks if the broker is connected (lifecycle — M70c).
   *
   * `true` while `connect()` has run and `disconnect()` has not, even during
   * a reconnect window: the lifecycle is intact, the backend is what is
   * down. Reachability is {@linkcode isHealthy}/{@linkcode reachability}.
   *
   * @returns `true` if connected, `false` otherwise
   * @since 0.1.0
   */
  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Backend reachability (M70c; a real round trip since M95b §3.6).
   *
   * `false` while the supervisor is in a fault window (the connection
   * dropped and the drive-mode reconnect has not yet succeeded) — that
   * short-circuit performs no round trip and is read ahead of the cache —
   * and `false` with no open connection. Otherwise the answer comes from
   * {@linkcode RabbitMqBroker.#openThrowawayChannel}, cached 5 s and
   * bounded 2 s, resolving `undefined` — could not determine — for a probe
   * that does not answer inside the bound.
   *
   * The M70c probe was `Promise.resolve(!this.#supervisor.faulted)` — a
   * flag read, which a HUNG broker never trips (a paused broker keeps its
   * socket; only a stopped one drops it), so a paused broker reported
   * `reachable: true` while no AMQP handshake could complete.
   *
   * **The cache and the bound live here rather than only at the health
   * indicator**, because the indicator is not the only caller: the realtime
   * backplane's `'messaging'` transport delegates to `isHealthy()` directly
   * and documents that it keeps no cache of its own. Without this, a real
   * round trip fired once per health poll and a paused broker left that
   * caller waiting on a promise that never settled.
   *
   * One bounded-window cost is named rather than hidden: against a PAUSED
   * broker the channel open itself never settles, so each abandoned poll
   * leaves one pending open that the `finally` cannot yet run for; the
   * pending opens settle and close on recovery (or with the connection at
   * `disconnect()`), and amqplib buffers them, so the window is transient
   * rather than a leak. The 5 s cache also bounds how many such pending
   * opens a polling endpoint can accumulate.
   *
   * @returns `true` when the broker answers a channel open, `false` when
   *   it is faulted, unconnected, or refuses the round trip, `undefined`
   *   when the round trip did not answer inside the bound
   * @since 0.1.0
   */
  async reachability(): Promise<boolean | undefined> {
    // Short-circuit, no round trip and NO cache: a fault window is a
    // positively known, always-current outage, and probing through a dying
    // connection would only burn it. Reading it ahead of the cache is what
    // keeps a stopped broker's `down` immediate rather than TTL-delayed.
    if (this.#supervisor.faulted) {
      return false;
    }
    const probe = this.#probe;
    if (probe === null || this.#connection === null) {
      return false;
    }
    return await probe();
  }

  /**
   * The round trip itself (M95b §3.6): open a throwaway channel and close it.
   *
   * `connection.createChannel()` is a real AMQP exchange that a paused broker
   * cannot answer and a stopped one fails outright; it needs no queue, no
   * exchange and no extra permission. The channel is its OWN, so a failure
   * cannot touch `#channel` — the single channel every publish and every
   * subscription shares, which a passive queue declare would have closed —
   * and it is released in a `finally`, since a leaked channel per poll would
   * be its own defect.
   */
  async #openThrowawayChannel(): Promise<boolean> {
    const connection = this.#connection;
    if (connection === null) {
      return false;
    }
    try {
      const channel = await connection.createChannel();
      try {
        return true;
      } finally {
        if (isCloseableChannel(channel)) {
          await channel.close();
        }
      }
    } catch {
      // The round trip failed: a stopped broker fails it outright, and a
      // hung one never settles and is resolved by the bound above.
      return false;
    }
  }

  /**
   * Boolean port member (M70c): `false` only when positively unreachable.
   *
   * A probe that could not answer inside the bound reports `true` — "not
   * known down" — because the port contract is boolean and the honest
   * tri-state is what {@linkcode RabbitMqBroker.reachability} carries. This
   * is the `ServiceBusBroker.isHealthy()` shape exactly.
   *
   * @returns `true` when the broker answers the probe or could not be
   *   probed, `false` when it is faulted, unconnected, or refuses it
   * @since 0.1.0
   */
  async isHealthy(): Promise<boolean> {
    const reachable = await this.reachability();
    return reachable !== false;
  }

  /**
   * Publishes a message to a topic.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic to publish to
   * @param message - The message payload
   * @returns Resolves when published
   * @since 0.1.0
   */
  publish<T>(topic: string, message: T, options?: PublishOptions): Promise<void> {
    return this.publishWithHeaders(topic, message, {}, options);
  }

  /** Publishes a message with framework-owned transport headers. @internal */
  async publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
    options?: PublishOptions,
  ): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqBroker is not connected');
    }
    const validated = await validatePublishOptions(options);
    const wireHeaders = buildTransportHeaders(validated, headers);
    const serialized = this.#serializer.serialize(message);
    const realChannel = this.#channel as unknown as PublishingChannel & {
      assertExchange(exchange: string, type: string, options?: unknown): Promise<void>;
    };

    // Build properties
    const properties: Record<string, unknown> = {};
    // RabbitMQ's native mapping: `deduplicationId` replaces the random uuid, so
    // a consumer's `MessageMetadata.messageId` is the producer's stable id.
    properties.messageId = validated.deduplicationId ?? this.#runtime.uuid();
    properties.headers = wireHeaders;
    if (typeof message === 'object' && message !== null) {
      // Try to extract existing messageId/timestamp/headers if present
      const msg = message as Record<string, unknown>;
      if (validated.deduplicationId === undefined && typeof msg.messageId === 'string') {
        properties.messageId = msg.messageId;
      }
    }
    // Set only when enabled, so `persistentMessages: false` publishes exactly
    // what every release before 0.9.0 published.
    if (this.#persistentMessages) {
      properties.persistent = true;
    }

    const content = Buffer.from(serialized, 'utf8');
    await this.#publishOn(
      realChannel,
      this.#confirmed,
      this.#exchangeName,
      topic,
      content,
      properties,
    );
  }

  /** One bounded publish path for original, retry, and dead-letter traffic. */
  async #publishOn(
    channel: PublishingChannel & {
      assertExchange(exchange: string, type: string, options?: unknown): Promise<void>;
    },
    confirmed: boolean,
    exchange: string,
    routingKey: string,
    content: Uint8Array,
    properties: Record<string, unknown>,
    requireRoute = false,
  ): Promise<void> {
    // Normal pub/sub may legitimately have no interested queue. A disposition
    // may not: a positive confirm also arrives for an unroutable publish.
    if (requireRoute && (!confirmed || !isCloseObservable(channel))) {
      throw new Error('RabbitMQ consumer recovery requires confirms and on/off return listeners');
    }
    const unencodable = amqpShortStringProblem(exchange, routingKey, properties);
    if (unencodable !== null) {
      // Never quoted: the refused value may be caller data.
      throw new RangeError(
        `RabbitMQ cannot publish: the ${unencodable} exceeds AMQP's 255 UTF-8 byte limit`,
      );
    }
    const dispositionId = requireRoute ? this.#runtime.uuid() : undefined;
    const outgoing = dispositionId === undefined ? properties : {
      ...properties,
      mandatory: true,
      headers: Object.fromEntries([
        ...Object.entries(properties.headers as Record<string, unknown>),
        [DISPOSITION_ID, dispositionId],
      ]),
    };
    const timeoutMs = this.#publishTimeoutMs;
    await withDeadline(
      async (signal) => {
        // The default exchange already exists and cannot be declared.
        if (exchange !== '') {
          await channel.assertExchange(exchange, 'topic', { durable: true });
        }
        if (!confirmed) {
          channel.publish(exchange, routingKey, content, outgoing);
          return;
        }
        await publishConfirmed(
          channel,
          exchange,
          routingKey,
          content,
          outgoing,
          dispositionId,
          requireRoute ? signal : undefined,
        );
      },
      {
        timeoutMs,
        onTimeout: () =>
          new Error(
            `RabbitMQ did not accept the message published to exchange "${exchange}" ` +
              `with routing key "${routingKey}" within ${timeoutMs} ms (publishTimeoutMs); ` +
              'it may still be accepted',
          ),
        timing: {
          setTimer: (fn, ms) => this.#runtime.setTimeout(fn, ms),
          clearTimer: (handle) => this.#runtime.clearTimeout(handle),
        },
      },
    );
  }

  /**
   * Subscribes to a topic.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic to subscribe to
   * @param handler - The handler to invoke for each message
   * @param options - Optional subscription options (queue for consumer group)
   * @returns The subscription handle
   * @since 0.1.0
   */
  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    validateConsumerQueue(
      options?.queue,
      this.#consumerOptions,
      (options as InternalSubscribeOptions | undefined)?.[REPLY_INBOX_TRANSIENT] === true,
    );
    if (!this.#channel) {
      throw new Error('RabbitMqBroker is not connected');
    }

    // Determine queue name
    const queueName = options?.queue ?? `${this.#defaultQueue}-${this.#runtime.uuid()}`;
    const isExclusive = options?.queue === undefined;

    // X10-1: the declaration carries the intent the shape already encodes.
    // A caller-supplied queue name is a consumer GROUP — durable, so it
    // survives a broker restart, which is what `queue` documents. An absent
    // name (the private per-subscriber queue) is transient: exclusive +
    // autoDelete. RabbitMQ 4 refuses the old unconditional `{ durable: false
    // }` named non-exclusive form outright (`541 INTERNAL-ERROR …
    // transient_nonexcl_queues`).
    //
    // F3: the broker's own reply inbox is ALSO transient, but that is
    // decided by a marker on the INTERNAL subscribe call (the inbox marks
    // itself in `inbox.ts`), never by pattern-matching the queue NAME —
    // `SubscribeOptions.queue` has no reserved-prefix restriction, so a
    // legitimate consumer group named e.g. `rr.inbox.orders` must stay a
    // normal durable group queue.
    // The marker is package-internal (F3): it travels on the broker's own
    // `createTopicInbox` closure call and is never on the public surface, so
    // the public `SubscribeOptions` is narrowed here to read it.
    const declareOptions: QueueDeclareOptions = isExclusive ||
        (options as InternalSubscribeOptions | undefined)?.[REPLY_INBOX_TRANSIENT] === true
      ? { exclusive: true, autoDelete: true }
      : { durable: true };

    // Without confirms and return listeners no failure can be disposed of, so
    // each stays unacked and the consumer stalls once `prefetch` is reached.
    // Without close() a failed disposition cannot release its channel, so the
    // replacement channel recovery opens would leave the originals stranded.
    if (
      this.#consumerOptions.retry && 'durable' in declareOptions &&
      (!this.#confirmed || !isCloseObservable(this.#channel) ||
        !isCloseableChannel(this.#channel))
    ) {
      throw new Error(
        'RabbitMQ consumer retries need a confirm channel with on/off return listeners and ' +
          'close(); inject a connection providing createConfirmChannel() or set ' +
          'consumerRetry: false',
      );
    }

    const subscriptionId = this.#runtime.uuid();
    const { consumerTag, channel } = await this.#consumeOn(
      queueName,
      topic,
      handler as MessageHandler<unknown>,
      declareOptions,
    );

    this.#activeConsumers.set(subscriptionId, {
      id: subscriptionId,
      topic,
      handler: handler as MessageHandler<unknown>,
      queue: isExclusive ? undefined : queueName,
      declareOptions,
      consumerTag,
      channel,
    });

    return {
      unsubscribe: async (): Promise<void> => {
        const consumer = this.#activeConsumers.get(subscriptionId);
        if (consumer) {
          try {
            const realCh = consumer.channel as unknown as { cancel(tag: string): Promise<void> };
            await realCh.cancel(consumer.consumerTag);
          } catch {
            // Ignore errors
          }
          this.#activeConsumers.delete(subscriptionId);
          // Delete exclusive queue on unsubscribe
          if (isExclusive && this.#channel) {
            try {
              const ch = this.#channel as unknown as { deleteQueue(queue: string): Promise<void> };
              await ch.deleteQueue(queueName);
            } catch {
              // Ignore errors
            }
          }
        }
      },
    };
  }

  /** Subscribes through the header-aware internal path. @internal */
  subscribeWithHeaders<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.subscribe(topic, handler, options);
  }

  /**
   * Sends a request and awaits a single correlated reply.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic a responder is listening on
   * @param message - The request payload
   * @param options - Reply timeout behavior
   * @returns The reply
   * @since 0.1.0
   */
  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes> {
    return this.requestWithHeaders(topic, message, {}, options);
  }

  /** Sends request-reply traffic with framework-owned headers. @internal */
  requestWithHeaders<TReq, TRes>(
    topic: string,
    message: TReq,
    headers: Readonly<Record<string, string>>,
    options?: RequestOptions,
  ): Promise<TRes> {
    return this.#rr.request<TRes>(topic, message, options, headers);
  }

  /**
   * Registers a responder whose result is returned to the requesting caller.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - The request topic to respond on
   * @param handler - Invoked per request; its result is returned to the caller
   * @param options - Consumer group behavior
   * @returns The active subscription
   * @since 0.1.0
   */
  respond<TReq, TRes>(
    topic: string,
    handler: RequestHandler<TReq, TRes>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.#rr.respond(
      topic,
      (message, metadata) => handler(message as TReq, metadata),
      options,
    );
  }

  /**
   * Creates the shared channel on the current connection — the ONE channel
   * factory, used by `connect()` and by the drive-mode reconnect alike, so a
   * reconnected broker keeps publisher confirms.
   *
   * A connection that can open a confirm channel gets one (a real amqplib
   * connection always can). One that cannot keeps a plain channel, and the
   * broker says so once: publishes on it resolve before RabbitMQ has stored
   * anything.
   */
  async #createChannel(): Promise<unknown> {
    const connection = this.#connection as IAmqpConnection;
    if (typeof connection.createConfirmChannel === 'function') {
      const channel = await connection.createConfirmChannel();
      this.#confirmed = true;
      await this.#applyPrefetch(channel);
      return channel;
    }
    const channel = await connection.createChannel();
    this.#confirmed = false;
    await this.#applyPrefetch(channel);
    if (!this.#warnedUnconfirmed) {
      this.#warnedUnconfirmed = true;
      const message = 'RabbitMqBroker: the injected AMQP connection has no ' +
        'createConfirmChannel(), so publishes are NOT confirmed: publish() resolves ' +
        'before RabbitMQ has stored the message, and a broker failure can lose it';
      // Called as a method, never detached: a logger may keep its state in
      // private fields (the M52c `logQueries` defect).
      if (this.#logger?.warn !== undefined) {
        this.#logger.warn(message);
      } else {
        this.#logger?.error(message);
      }
    }
    return channel;
  }

  /** Injected minimal facades may omit QoS; real amqplib always supplies it. */
  async #applyPrefetch(channel: unknown): Promise<void> {
    const qos = channel as { prefetch?: (count: number) => Promise<unknown> };
    if (typeof qos.prefetch === 'function') {
      await qos.prefetch(this.#consumerOptions.prefetch);
    } else {
      this.#logger?.error(
        'RabbitMqBroker: injected channel has no prefetch(); deliveries are unbounded',
      );
    }
  }

  /**
   * Re-asserts the topic exchange on the current channel (idempotent).
   */
  async #reassertExchange(): Promise<void> {
    const realChannel = this.#channel as unknown as PublishingChannel & {
      assertExchange(exchange: string, type: string, options?: unknown): Promise<void>;
    };
    await realChannel.assertExchange(this.#exchangeName, 'topic', { durable: true });
  }

  /**
   * Establishes a consumer for a spec on the current channel, returning the
   * fresh tag and channel. Shared by {@linkcode subscribe} and the drive-mode
   * replay so both derive the consumer identically.
   */
  async #consumeOn(
    queueName: string,
    topic: string,
    handler: MessageHandler<unknown>,
    declareOptions: QueueDeclareOptions,
  ): Promise<{ consumerTag: string; channel: unknown }> {
    const realChannel = this.#channel as unknown as PublishingChannel & {
      assertExchange(exchange: string, type: string, options?: unknown): Promise<void>;
      assertQueue(queue: string, options?: unknown): Promise<{ queue: string }>;
      bindQueue(queue: string, source: string, pattern: string): Promise<void>;
      consume(
        queue: string,
        onMessage: (msg: unknown) => void,
        options?: unknown,
      ): Promise<{ consumerTag: string }>;
      ack(msg: unknown): void;
      nack(msg: unknown, allUpTo: boolean, requeue: boolean): void;
    };

    // Assert topic exchange
    await realChannel.assertExchange(this.#exchangeName, 'topic', { durable: true });

    // Assert queue and bind to topic — with the shape the subscription's
    // intent demands (X10-1), not a fixed one.
    await realChannel.assertQueue(queueName, declareOptions);
    await realChannel.bindQueue(queueName, this.#exchangeName, topic);

    const policy = this.#consumerOptions;
    const retry = policy.retry && 'durable' in declareOptions;
    const confirmed = this.#confirmed;
    if (retry) {
      for (const delay of new Set(policy.delaysMs)) {
        // The original is acked once this copy is confirmed, so the copy must
        // survive its own expiry. Classic dead-lettering is at-most-once and
        // drops the copy when Q cannot take it (measured on RabbitMQ 4: Q
        // absent at expiry, created a second later, received nothing in 240 s).
        // A quorum queue with at-least-once dead-lettering holds it and
        // redelivers once Q exists; reject-publish overflow is what that
        // strategy requires.
        await realChannel.assertQueue(`${queueName}.retry.${delay}ms`, {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum',
            'x-dead-letter-strategy': 'at-least-once',
            'x-overflow': 'reject-publish',
            'x-message-ttl': delay,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': queueName,
          },
        });
      }
      await realChannel.assertQueue(`${queueName}.dead`, {
        durable: true,
        arguments: { 'x-max-length': policy.deadLetterMaxLength },
      });
    }

    const result = await realChannel.consume(
      queueName,
      async (msg) => {
        if (!msg) return;
        const delivered = msg as { content: Uint8Array; properties?: Record<string, unknown> };
        const properties = delivered.properties ?? {};
        let failed = false;
        let failure: unknown;
        let deterministic = false;
        let deserialized: unknown;
        try {
          deserialized = this.#serializer.deserialize<unknown>(
            new TextDecoder().decode(delivered.content),
          );
        } catch (error) {
          failed = true;
          deterministic = true;
          failure = error;
        }
        if (!failed) {
          try {
            const metadata: MessageMetadata = {
              topic,
              messageId: properties.messageId as string ?? this.#runtime.uuid(),
              timestamp: properties.timestamp as Date ?? new Date(this.#runtime.now()),
              headers: normalizeTransportHeaders(
                properties.headers as Readonly<Record<string, TransportHeaderValue>> | undefined,
              ),
            };
            await handler(deserialized, metadata);
          } catch (error) {
            failed = true;
            failure = error;
            deterministic = error instanceof IntegrationEventRejectedError;
          }
        }

        // Disposition is outside the handler try: ack/publish failures never
        // become handler failures and never trigger a second disposition.
        try {
          if (!failed) {
            realChannel.ack(msg);
            return;
          }
          if (!retry) {
            realChannel.nack(msg, false, false);
            this.#logger?.error(`Message handler failed: ${describeError(failure)}`);
            return;
          }
          const incoming = properties.headers as Record<string, unknown> | undefined;
          const attemptHeader = incoming?.['x-setu-attempt'];
          const validAttempt = attemptHeader === undefined ||
            (Number.isSafeInteger(attemptHeader) && (attemptHeader as number) >= 1);
          const attempt = validAttempt && attemptHeader !== undefined ? attemptHeader as number : 1;
          let retryable = !deterministic && validAttempt;
          if (retryable && policy.isRetryable !== undefined) {
            try {
              retryable = policy.isRetryable(failure) !== false;
            } catch (error) {
              this.#logger?.error(`RabbitMQ retry classifier failed: ${describeError(error)}`);
            }
          }
          const dead = !retryable || attempt >= policy.maxAttempts;
          const delay = policy.delaysMs[Math.min(attempt - 1, policy.delaysMs.length - 1)]!;
          const target = dead ? `${queueName}.dead` : `${queueName}.retry.${delay}ms`;
          // fromEntries keeps even "__proto__" as an own data property.
          // CC/BCC are sender-selected routing keys: re-published to the
          // default exchange they deliver the copy to any queue they name.
          const headers = Object.fromEntries([
            ...Object.entries(incoming ?? {}).filter(([key]) => key !== 'CC' && key !== 'BCC'),
            ...(dead
              ? [
                ['x-setu-attempts', attempt],
                ['x-setu-topic', topic],
                ['x-setu-error', deadLetterError(failure)],
              ]
              : [['x-setu-attempt', attempt + 1]]),
          ]);
          // RabbitMQ validates user_id against the publishing connection, so
          // another user's ID closes the channel and redelivers in a loop.
          const copied = Object.fromEntries(
            Object.entries(properties).filter(([key]) => key !== 'expiration' && key !== 'userId'),
          );
          copied.headers = headers;
          copied.persistent = true;
          await this.#publishOn(
            realChannel,
            confirmed,
            '',
            target,
            delivered.content,
            copied,
            true,
          );
          realChannel.ack(msg);
          if (dead) {
            this.#logger?.error(
              describeLogText(
                `RabbitMQ dead-lettered to "${target}", topic "${topic}", attempts ${attempt}: ${
                  deadLetterError(failure)
                }`,
              ),
            );
          }
        } catch (error) {
          // Leave the original unacked when disposition fails; channel closure
          // returns it to Q. A timed-out confirm can arrive late, so requeueing
          // immediately would create an unbounded duplicate loop.
          this.#logger?.error(
            `RabbitMQ disposition failed; original remains unacked: ${describeError(error)}`,
          );
          await this.#recoverAfterDispositionFailure(realChannel);
        }
      },
      { noAck: false },
    );

    return { consumerTag: result.consumerTag, channel: this.#channel };
  }

  /**
   * Closes the channel a failed disposition ran on and starts drive-mode
   * recovery. Without it a live channel keeps every such original unacked
   * until `prefetch` of them stall the consumer, because the fault listeners
   * watch the connection only and closing a channel does not reach them.
   * Closing returns the originals to `Q`; the replay re-declares the retry and
   * dead queues before consuming, so a deleted destination is repaired too.
   * Concurrent failures on one channel close it once, and a channel already
   * replaced by an earlier recovery is left alone.
   */
  async #recoverAfterDispositionFailure(channel: object): Promise<void> {
    if (this.#channel !== channel || this.#closingChannels.has(channel)) {
      return;
    }
    this.#closingChannels.add(channel);
    this.#supervisor.fault();
    if (isCloseableChannel(channel)) {
      try {
        await channel.close();
      } catch {
        // Already closed by the broker or a concurrent failure.
      }
    }
  }

  /**
   * Drive-mode reconnect: re-establish the connection (when the broker owns
   * it) and a fresh channel.
   */
  async #reconnect(): Promise<void> {
    if (this.#injectedClient === undefined && this.#connection !== null) {
      try {
        await (this.#connection as unknown as { close(): Promise<void> }).close();
      } catch {
        // The old connection is already gone; ignore close failures
      }
      this.#connection = await resolveClient(this.#url, undefined);
    }
    this.#channel = await this.#createChannel();
  }

  /**
   * Drive-mode replay: re-subscribe every active consumer on the fresh
   * channel. This is why X2-1's queues showed no consumers after a broker
   * restart and never recovered — without it the subscriptions are lost.
   */
  async #replayConsumers(): Promise<void> {
    for (const consumer of [...this.#activeConsumers.values()]) {
      const queueName = consumer.queue ?? `${this.#defaultQueue}-${consumer.id}`;
      const { consumerTag, channel } = await this.#consumeOn(
        queueName,
        consumer.topic,
        consumer.handler,
        consumer.declareOptions,
      );
      consumer.consumerTag = consumerTag;
      consumer.channel = channel;
    }
  }

  /**
   * Attaches the `'error'`/`'close'` fault listeners to the current
   * connection and returns a disposer that removes them. A client without an
   * event surface (a minimal injected fake) returns a no-op disposer; the
   * fault window is then only observable through the probe, which still
   * reports the truth (no fault flag set).
   */
  #attachFaultListeners(onFault: () => void): () => void {
    const connection = this.#connection;
    if (connection === null || typeof connection.on !== 'function') {
      return () => {};
    }
    const listener = (err?: unknown): void => {
      void err;
      onFault();
    };
    connection.on('error', listener);
    connection.on('close', listener);
    return (): void => {
      if (typeof connection.off === 'function') {
        connection.off('error', listener);
        connection.off('close', listener);
      }
    };
  }
}
