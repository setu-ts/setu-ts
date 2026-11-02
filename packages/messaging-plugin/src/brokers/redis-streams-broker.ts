import {
  attachConnectionErrorReporter,
  createCachedProbe,
  withDeadline,
  resolveProbeTiming,
} from '@setu-ts/common';
import {
  OptionalDependencyUnavailableError,
  toBackendFault,
} from '@setu-ts/common';
import type { ConnectionErrorReporter } from '@setu-ts/common';
import type {
  ISubscription,
  MessageHandler,
  MessageMetadata,
  PublishOptions,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { IntegrationEventRejectedError, PublishTimeoutError } from '../errors.ts';
import { describeError } from './describe-error.ts';
import { createTopicInbox } from './inbox.ts';
import { buildTransportHeaders, validatePublishOptions } from './publish-options.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import type { IRedisStreamsClient, RedisStreamsOptions } from '../interfaces/index.ts';

import { resolvePublishTimeoutMs } from './publish-timeout.ts';

/**
 * The stream field carrying the serialized message body. Reserved: it is never
 * written as a transport header, and the first occurrence wins on read.
 */
const PAYLOAD_FIELD = 'payload';
/** Do not let a hung handler or cleanup query hold shutdown indefinitely. */
const SHUTDOWN_DRAIN_MS = 5000;

// XINFO + DELCONSUMER must be one server operation for FOREIGN consumers:
// a live replica can resume reading between two client-side commands.
const SWEEP_CONSUMERS = `
local consumers = redis.call('XINFO', 'CONSUMERS', KEYS[1], ARGV[1])
local removed = 0
for _, fields in ipairs(consumers) do
  local info = {}
  for i = 1, #fields, 2 do info[fields[i]] = fields[i+1] end
  local inactive = info.inactive
  if inactive == nil or inactive < 0 then inactive = info.idle end
  if info.name ~= ARGV[2] and info.pending == 0 and inactive > tonumber(ARGV[3]) then
    redis.call('XGROUP', 'DELCONSUMER', KEYS[1], ARGV[1], info.name)
    removed = removed + 1
  end
end
return removed`;

/**
 * Lazily load ioredis at runtime. Pin to 5.x for stability.
 *
 * @returns The ioredis constructor
 * @throws {Error} If the ioredis package cannot be resolved
 */
async function loadIoredis(): Promise<typeof import('ioredis').Redis> {
  try {
    const mod = await import('ioredis');
    return mod.Redis;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('ioredis', {
      requiredBy: '@setu-ts/messaging-plugin',
      cause: error,
    });
  }
}

/** Constructs an ioredis client without opening its socket before connect(). */
export function createLazyRedisClient(
  RedisCtor: new (url: string, options: { readonly lazyConnect: true }) => unknown,
  url: string,
): IRedisStreamsClient {
  return new RedisCtor(url, { lazyConnect: true }) as IRedisStreamsClient;
}

/**
 * Validate that the supplied object has the structural shape required by
 * RedisStreamsBroker. Checks the exact methods the broker calls — no duplicates.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IRedisStreamsClient {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = [
    'xadd',
    'xgroup',
    'xreadgroup',
    'xack',
    'quit',
    'connect',
    'xpending',
    'xclaim',
    'xinfo',
  ];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the Redis client: prefer injected `options.client`, then lazy-load
 * ioredis from npm.
 *
 * @param url - Redis connection URL
 * @param injectedClient - Optionally injected ioredis-compatible client
 * @param reporter - Receives the connection errors of BOTH the built and an
 *   injected client (M131a X88-3): an injected node-redis client's outages must
 *   be as visible as a built ioredis client's. The attach is structural, so a
 *   client without `on` is left alone.
 * @returns The resolved client instance
 * @throws {Error} If no client injected and ioredis cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient: IRedisStreamsClient | undefined,
  reporter: ConnectionErrorReporter | undefined,
): Promise<IRedisStreamsClient> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected Redis client does not match the required structural shape ' +
          '(needs: xadd, xgroup, xreadgroup, xack, quit, connect, xpending, xclaim, xinfo)',
      );
    }
    attachConnectionErrorReporter(injectedClient, reporter);
    return injectedClient;
  }
  const RedisCtor = await loadIoredis();
  const client = createLazyRedisClient(RedisCtor, url);
  attachConnectionErrorReporter(client, reporter);
  return client;
}

/**
 * The per-subscription work of one shared poll or reclaim tick (M131a X88-7).
 *
 * The broker runs ONE poll timer and ONE reclaim timer, started in `connect()`
 * (startup, no active span) and serving every subscription. Each subscription
 * keeps its own in-flight guard, stop flag and drain, so a slow subscription
 * still skips only its own tick, and a subscription added after start is served
 * by the running timers.
 */
interface ConsumerLoop {
  /** Runs this subscription's poll for one tick (driven by the shared poll timer). */
  pollTick: () => void;
  /** Runs this subscription's reclaim for one tick (driven by the shared reclaim timer). */
  reclaimTick: () => void;
  /** Stops and drains this subscription (the shared timers are cleared by `disconnect`). */
  unsubscribe: () => Promise<void>;
}

interface ConsumerLoopDeps {
  readonly runtime: IRuntimeServices;
  readonly client: IRedisStreamsClient;
  readonly topic: string;
  readonly groupId: string;
  readonly consumerId: string;
  readonly deliverHandler: MessageHandler;
  readonly blockSizeMs: number;
  readonly maxAttempts: number;
  readonly delaysMs: readonly number[];
  readonly logger: { error: (msg: string) => void } | undefined;
  readonly deliver: (
    client: IRedisStreamsClient,
    topic: string,
    groupId: string,
    handler: MessageHandler,
    entry: [string, string[]],
    deliveries: number,
    active: () => boolean,
  ) => Promise<void>;
  readonly deadLetter: (
    client: IRedisStreamsClient,
    topic: string,
    groupId: string,
    entry: [string, string[]],
    deliveries: number,
    active: () => boolean,
  ) => Promise<void>;
  readonly cleanConsumers: (
    client: IRedisStreamsClient,
    topic: string,
    groupId: string,
    consumerId: string,
    final: boolean,
    active: () => boolean,
  ) => Promise<void>;
}

/**
 * Builds the per-subscription consumer loop (poll, reclaim, in-flight guards,
 * stop flag and drain) that one shared timer tick drives.
 */
function createConsumerLoop(deps: ConsumerLoopDeps): ConsumerLoop {
  const {
    runtime,
    client,
    topic,
    groupId,
    consumerId,
    deliverHandler,
    blockSizeMs,
    maxAttempts,
    delaysMs,
    logger,
    deliver: deliverFn,
    deadLetter: deadLetterFn,
    cleanConsumers: cleanConsumersFn,
  } = deps;
  let stopped = false;
  let abandoned = false;
  const active = (): boolean => !abandoned;
  let pollFlight: Promise<void> | undefined;
  let reclaimFlight: Promise<void> | undefined;
  const delivering = new Set<string>();
  // Rotate through the PEL so a high-tier first batch cannot starve later entries.
  let pendingStart = '-';
  const deliver = async (entry: [string, string[]], deliveries: number): Promise<void> => {
    delivering.add(entry[0]);
    try {
      await deliverFn(client, topic, groupId, deliverHandler, entry, deliveries, active);
    } finally {
      delivering.delete(entry[0]);
    }
  };
  const poll = async (): Promise<void> => {
    // Read ONE entry at a time and keep reading while entries arrive. A
    // batched read leases every entry at read time, so an entry queued behind
    // earlier handlers ages toward delaysMs[0] and another replica's reclaim
    // could take it before this replica starts it. One-at-a-time keeps the
    // lease equal to a single handler run, which is what the docs promise.
    while (!stopped) {
      const result = await client.xreadgroup(
        'GROUP',
        groupId,
        consumerId,
        'COUNT',
        '1',
        'BLOCK',
        String(blockSizeMs),
        'STREAMS',
        topic,
        '>',
      );
      if (!result) return;
      const entries = result[0][1] as Array<[string, string[]]>;
      if (entries.length === 0) return;
      for (const entry of entries) {
        if (stopped) return;
        await deliver(entry, 1);
      }
    }
  };
  const reclaim = async (): Promise<void> => {
    const pending = await client.xpending(
      topic,
      groupId,
      'IDLE',
      String(delaysMs[0]),
      pendingStart,
      '+',
      '10',
    );
    pendingStart = pending.length === 10 ? `(${pending[pending.length - 1][0]}` : '-';
    for (const [id, , idle, deliveries] of pending) {
      if (stopped) break;
      const delay = delaysMs[Math.min(deliveries - 1, delaysMs.length - 1)];
      if (idle < delay || delivering.has(id)) continue;
      // The server rechecks min-idle atomically. An empty reply can mean a
      // lost race OR a trimmed entry: never ACK it (that could ACK the winner).
      const entries = await client.xclaim(topic, groupId, consumerId, String(delay), id);
      for (const entry of entries) {
        if (stopped) break;
        // Redis 6.2 claims a trimmed PEL entry and returns null; Redis 7
        // drops it server-side and returns no entry. Only null proves a
        // successful claim of missing data; an empty reply may be a race.
        if (entry === null) {
          await client.xack(topic, groupId, id);
          continue;
        }
        if (deliveries >= maxAttempts) {
          // Acquire fields/ownership, but never invoke the handler beyond its budget.
          await deadLetterFn(client, topic, groupId, entry, deliveries, active);
        } else {
          await deliver(entry, deliveries + 1);
        }
      }
    }
    if (!stopped) await cleanConsumersFn(client, topic, groupId, consumerId, false, active);
  };
  const observe = (work: () => Promise<void>, label: string): Promise<void> =>
    work().catch((error: unknown) => {
      logger?.error(`${label} error: ${describeError(error)}`);
    });
  const pollTick = (): void => {
    if (stopped || pollFlight !== undefined) return;
    pollFlight = observe(poll, 'Poll').finally(() => {
      pollFlight = undefined;
    });
  };
  const reclaimTick = (): void => {
    if (stopped || reclaimFlight !== undefined) return;
    reclaimFlight = observe(reclaim, 'Reclaim').finally(() => {
      reclaimFlight = undefined;
    });
  };
  let closing: Promise<void> | undefined;
  const unsubscribe = (): Promise<void> => {
    closing ??= (async () => {
      stopped = true;
      // The shared poll/reclaim timers are cleared by `disconnect()`, not here:
      // one subscription stopping must not stop the timers serving its siblings.
      let timeoutHandle: TimerHandle;
      const deadline = new Promise<void>((resolve) => {
        timeoutHandle = runtime.setTimeout(() => {
          abandoned = true;
          logger?.error('Redis subscription shutdown drain timed out; pending work retained');
          resolve();
        }, SHUTDOWN_DRAIN_MS);
      });
      try {
        await Promise.race([
          observe(async () => {
            await Promise.all([pollFlight, reclaimFlight]);
            if (!abandoned) {
              await cleanConsumersFn(client, topic, groupId, consumerId, true, active);
            }
          }, 'Consumer cleanup'),
          deadline,
        ]);
      } finally {
        runtime.clearTimeout(timeoutHandle);
      }
    })();
    return closing;
  };
  return { pollTick, reclaimTick, unsubscribe };
}

/**
 * Internal subscription entry: its id, the shared-timer ticks, and the drain.
 */
interface ActiveSubscription {
  id: string;
  pollTick: () => void;
  reclaimTick: () => void;
  unsubscribe: () => Promise<void>;
}

/**
 * Redis Streams message broker implementation.
 *
 * Uses Redis Streams for persistent message delivery with consumer groups
 * for load-balanced processing.
 *
 * @since 0.1.0
 */
export class RedisStreamsBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #url: string;
  #injectedClient: IRedisStreamsClient | undefined;
  #defaultQueue: string;
  #publishTimeoutMs: number;
  #pollIntervalMs: number;
  #blockSizeMs: number;
  #logger?: { error: (msg: string) => void };
  #reporter: ConnectionErrorReporter | undefined;
  #client: IRedisStreamsClient | null = null;
  #ready = false;
  #activeSubscriptions: Map<string, ActiveSubscription>;
  #maxAttempts: number;
  #delaysMs: readonly number[];
  #isRetryable: ((error: unknown) => boolean) | undefined;
  #reclaimIntervalMs: number;
  #deadLetterMaxLen: number;
  #consumerIdleSweepMs: number;
  #rr: RequestReplyCore;
  #probe: () => Promise<boolean>;
  /** The one poll timer serving every subscription (M131a X88-7). */
  #pollTimer: TimerHandle | undefined;
  /** The one reclaim timer serving every subscription (M131a X88-7). */
  #reclaimTimer: TimerHandle | undefined;

  /**
   * Creates a new Redis Streams broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   * @param options - Redis connection and polling options
   * @throws {RangeError} If a retry, reclaim, retention, sweep or publish bound is invalid
   */
  constructor(runtime: IRuntimeServices, serializer: ISerializer, options?: RedisStreamsOptions) {
    this.#publishTimeoutMs = resolvePublishTimeoutMs(options?.publishTimeoutMs);
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#url = options?.url ?? 'redis://localhost:6379';
    this.#injectedClient = options?.client;
    this.#defaultQueue = options?.defaultQueue ?? 'messaging-consumers';
    this.#pollIntervalMs = options?.pollIntervalMs ?? 100;
    this.#blockSizeMs = options?.blockSizeMs ?? 100;
    this.#maxAttempts = options?.consumerRetry?.maxAttempts ?? 5;
    this.#delaysMs = [...(options?.consumerRetry?.delaysMs ?? [30000, 60000, 300000, 600000])];
    this.#isRetryable = options?.consumerRetry?.isRetryable;
    this.#reclaimIntervalMs = options?.reclaimIntervalMs ?? 5000;
    this.#deadLetterMaxLen = options?.deadLetterMaxLen ?? 10000;
    this.#consumerIdleSweepMs = options?.consumerIdleSweepMs ?? 3600000;
    const positiveInteger = (name: string, value: number, max = Number.MAX_SAFE_INTEGER): void => {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new RangeError(
          `RedisStreamsBroker ${name} must be a positive integer within its bound`,
        );
      }
    };
    positiveInteger('consumerRetry.maxAttempts', this.#maxAttempts);
    positiveInteger('deadLetterMaxLen', this.#deadLetterMaxLen);
    positiveInteger('reclaimIntervalMs', this.#reclaimIntervalMs, 2147483647);
    positiveInteger('consumerIdleSweepMs', this.#consumerIdleSweepMs, 2147483647);
    if (this.#delaysMs.length === 0) {
      throw new RangeError('RedisStreamsBroker consumerRetry.delaysMs must be nonempty');
    }
    for (const [index, delay] of this.#delaysMs.entries()) {
      positiveInteger('consumerRetry.delaysMs', delay, 2147483647);
      if (index > 0 && delay < this.#delaysMs[index - 1]) {
        throw new RangeError('RedisStreamsBroker consumerRetry.delaysMs must be nondecreasing');
      }
    }
    if (options?.logger) {
      this.#logger = options.logger;
    }
    this.#reporter = options?.connectionErrorReporter;
    this.#activeSubscriptions = new Map();
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
    // Built once so the TTL cache and coalescing persist across health
    // scrapes (M70c §3.3). The inner probe reads the live client each call
    // (it is set in connect()); a rejecting ping is unreachable.
    this.#probe = createCachedProbe({
      probe: async () => {
        const client = this.#client;
        if (client === null || typeof client.ping !== 'function') {
          return false;
        }
        const ping = client.ping;
        await ping.call(client);
        return true;
      },
      hrtime: () => this.#runtime.hrtime(),
      setTimer: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimer: (handle) => this.#runtime.clearTimeout(handle),
    });
  }

  /**
   * Connects the broker to Redis.
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    this.#client = await resolveClient(this.#url, this.#injectedClient, this.#reporter);
    if (typeof this.#client.connect === 'function') {
      await this.#client.connect();
    }
    // M131a X88-7: ONE poll timer and ONE reclaim timer, started here at
    // connect() (startup, no active span), serve every subscription. Creating
    // them in subscribe() would parent each poll's span to the caller's
    // request context.
    this.#pollTimer = this.#runtime.setInterval(() => {
      for (const subscription of this.#activeSubscriptions.values()) {
        subscription.pollTick();
      }
    }, this.#pollIntervalMs);
    this.#reclaimTimer = this.#runtime.setInterval(() => {
      for (const subscription of this.#activeSubscriptions.values()) {
        subscription.reclaimTick();
      }
    }, this.#reclaimIntervalMs);
    this.#ready = true;
  }

  /**
   * Disconnects the broker and clears all subscriptions.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  async disconnect(): Promise<void> {
    // Stop the shared timers first: a tick landing after a subscription has
    // been removed would find nothing to serve, and a tick during the drain
    // would race the in-flight guard.
    if (this.#pollTimer !== undefined) {
      this.#runtime.clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#reclaimTimer !== undefined) {
      this.#runtime.clearInterval(this.#reclaimTimer);
      this.#reclaimTimer = undefined;
    }
    await this.#rr.close();
    // In parallel: each drain is bounded by SHUTDOWN_DRAIN_MS, and draining in
    // sequence would multiply that bound by the subscription count.
    await Promise.all(
      [...this.#activeSubscriptions.values()].map((subscription) => subscription.unsubscribe()),
    );

    if (this.#client) {
      await this.#client.quit();
    }
    this.#client = null;
    this.#ready = false;
  }

  /**
   * Checks if the broker is connected.
   *
   * @returns `true` if connected, `false` otherwise
   * @since 0.1.0
   */
  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Tri-state backend reachability (M70c).
   *
   * ioredis auto-reconnects via its default retry strategy, so the broker
   * does not run a reconnect loop of its own; the truth is what `ping()`
   * reports right now. `true` when `ping()` resolves, `false` when it
   * rejects (the server is down or the socket is mid-reconnect), `undefined`
   * when the injected client exposes no `ping` (a minimal fake) — in which
   * case the indicator reports `reachable: 'unknown'` rather than lying.
   *
   * @returns `true`/`false`/`undefined` as described
   * @since 0.1.0
   */
  async reachability(): Promise<boolean | undefined> {
    const client = this.#client;
    if (client === null || typeof client.ping !== 'function') {
      return undefined;
    }
    return await this.#probe();
  }

  /**
   * Boolean port member (M70c): `false` only when positively unreachable.
   *
   * @returns `true` when reachable or unprobeable, `false` when `ping` fails
   * @since 0.1.0
   */
  async isHealthy(): Promise<boolean> {
    const reachable = await this.reachability();
    return reachable !== false;
  }

  /**
   * Publishes a message to a topic (Redis stream).
   *
   * @typeParam T - The message payload type
   * @param topic - The topic (stream name) to publish to
   * @param message - The message payload
   * @param options - Caller headers, ordering key and de-duplication id
   * @returns Resolves when published
   * @throws {PublishTimeoutError} When publishTimeoutMs expires; delivery remains possible
   * @since 0.1.0
   */
  publish<T>(topic: string, message: T, options?: PublishOptions): Promise<void> {
    return this.publishWithHeaders(topic, message, {}, options);
  }

  /**
   * Publishes with framework-owned headers under the configured acknowledgement bound.
   * @param topic - Destination topic
   * @param message - Payload to serialize
   * @param headers - Framework-owned transport headers
   * @param options - Caller headers, ordering key and de-duplication id
   * @returns Resolves when the transport acknowledges the publish
   * @throws {PublishTimeoutError} When publishTimeoutMs expires; delivery remains possible
   * @internal
   */
  async publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
    options?: PublishOptions,
  ): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisStreamsBroker is not connected');
    }
    const validated = await validatePublishOptions(options);
    const wireHeaders = buildTransportHeaders(validated, headers);
    const serialized = this.#serializer.serialize(message);
    // XADD with '*' for auto-generated ID. Headers ride as extra field/value
    // pairs beside `payload`, so `payload` is RESERVED: emitting a second field
    // with that name would shadow the body, and the reader would hand the
    // header value to the deserializer instead of the message.
    const fields = Object.entries(wireHeaders)
      .filter(([key]) => key !== PAYLOAD_FIELD)
      .flatMap(([key, value]) => [key, value]);
    const client = this.#client;
    try {
      await withDeadline(() => client.xadd(topic, '*', PAYLOAD_FIELD, serialized, ...fields), {
        timeoutMs: this.#publishTimeoutMs,
        onTimeout: () =>
          new PublishTimeoutError(
            `Redis did not acknowledge the message published to ${JSON.stringify(topic)} within ${this.#publishTimeoutMs} ms (publishTimeoutMs); it may still be delivered`,
            { topic, timeoutMs: this.#publishTimeoutMs },
          ),
        timing: resolveProbeTiming(this.#runtime),
      });
    } catch (error) {
      // M131a X88-5: a backend fault says whether the message was applied.
      // `PublishTimeoutError` is NOT rewrapped — it keeps its name and carries
      // the 504 hint itself. An unrecognised shape passes through unchanged.
      if (error instanceof PublishTimeoutError) throw error;
      const fault = toBackendFault(error, 'messaging-plugin: redis-streams broker');
      if (fault !== undefined) throw fault;
      throw error;
    }
  }

  /**
   * Subscribes to a topic using Redis Streams consumer groups.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic (stream name) to subscribe to
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
    if (!this.#client) {
      throw new Error('RedisStreamsBroker is not connected');
    }

    const groupId = options?.queue ?? this.#defaultQueue;
    const consumerId = this.#runtime.uuid();
    const subscriptionId = this.#runtime.uuid();

    // Ensure the consumer group exists (swallow BUSYGROUP error)
    try {
      await this.#client.xgroup('CREATE', topic, groupId, '$', 'MKSTREAM');
    } catch (error) {
      // BUSYGROUP means the group already exists - that's fine
      const err = error as Error;
      if (!err.message.includes('BUSYGROUP')) {
        throw error;
      }
    }

    const client = this.#client;
    const deliverHandler: MessageHandler = (message, metadata) => handler(message as T, metadata);
    // M131a X88-7: the per-subscription loop (poll, reclaim, in-flight guard,
    // stop flag and drain) is built here, but its timers are the broker's ONE
    // shared poll/reclaim timers, started in connect(). `subscribe()` no longer
    // creates a timer, so a handler that subscribes lazily no longer parents
    // poll spans to its request.
    const loop = createConsumerLoop({
      runtime: this.#runtime,
      client,
      topic,
      groupId,
      consumerId,
      deliverHandler,
      blockSizeMs: this.#blockSizeMs,
      maxAttempts: this.#maxAttempts,
      delaysMs: this.#delaysMs,
      logger: this.#logger,
      deliver: (client, topic, group, handler, entry, deliveries, active) =>
        this.#deliver(client, topic, group, handler, entry, deliveries, active),
      deadLetter: (client, topic, group, entry, deliveries, active) =>
        this.#deadLetter(client, topic, group, entry, deliveries, active),
      cleanConsumers: (client, topic, group, consumerId, final, active) =>
        this.#cleanConsumers(client, topic, group, consumerId, final, active),
    });
    const unsubscribe = (): Promise<void> => {
      const done = loop.unsubscribe();
      // The shared timers keep running; this subscription is removed so the
      // next tick no longer serves it.
      return done.finally(() => {
        this.#activeSubscriptions.delete(subscriptionId);
      });
    };

    const subscription: ActiveSubscription = {
      id: subscriptionId,
      pollTick: loop.pollTick,
      reclaimTick: loop.reclaimTick,
      unsubscribe,
    };
    this.#activeSubscriptions.set(subscriptionId, subscription);

    return {
      unsubscribe,
    };
  }

  async #deliver(
    client: IRedisStreamsClient,
    topic: string,
    group: string,
    handler: MessageHandler,
    entry: [string, string[]],
    deliveries: number,
    active: () => boolean,
  ): Promise<void> {
    const [id, fields] = entry;
    let payload: string | null = null;
    const headerPairs: Array<[string, string]> = [];
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === PAYLOAD_FIELD) payload ??= fields[i + 1];
      else headerPairs.push([fields[i], fields[i + 1]]);
    }
    let message: unknown;
    try {
      if (payload === null) throw new Error('Missing message payload');
      message = this.#serializer.deserialize(payload);
    } catch {
      await this.#deadLetter(client, topic, group, entry, deliveries, active);
      return;
    }
    const metadata: MessageMetadata = {
      topic,
      messageId: id,
      timestamp: new Date(parseInt(id.split('-')[0])),
      headers: Object.fromEntries(headerPairs),
    };
    try {
      await handler(message, metadata);
    } catch (error) {
      if (!active()) return;
      this.#logger?.error(`Message handler failed: ${describeError(error)}`);
      let retryable = true;
      if (this.#isRetryable !== undefined) {
        try {
          retryable = this.#isRetryable(error);
        } catch (classifierError) {
          this.#logger?.error(`Retry classifier failed: ${describeError(classifierError)}`);
        }
      }
      let integrationRejected = false;
      try {
        integrationRejected = error instanceof IntegrationEventRejectedError;
      } catch {
        // A hostile thrown value may reject prototype inspection. Keep the
        // classifier result and the rest of this delivery batch intact.
      }
      if (integrationRejected || !retryable || deliveries >= this.#maxAttempts) {
        await this.#deadLetter(client, topic, group, entry, deliveries, active);
      }
      return;
    }
    // An ACK error is a transport failure, never a handler/classifier failure.
    if (active()) await client.xack(topic, group, id);
  }

  async #deadLetter(
    client: IRedisStreamsClient,
    topic: string,
    group: string,
    [id, fields]: [string, string[]],
    deliveries: number,
    active: () => boolean,
  ): Promise<void> {
    await client.xadd(
      `${topic}.dead.${group}`,
      'MAXLEN',
      '~',
      String(this.#deadLetterMaxLen),
      '*',
      ...fields,
      'x-setu-source-id',
      id,
      'x-setu-deliveries',
      String(deliveries),
    );
    // XADD must succeed BEFORE XACK: a crash may duplicate, but cannot lose the source.
    if (active()) await client.xack(topic, group, id);
  }

  async #cleanConsumers(
    client: IRedisStreamsClient,
    topic: string,
    group: string,
    self: string,
    closing: boolean,
    active: () => boolean,
  ): Promise<void> {
    if (!active()) return;
    if (!closing) {
      // ioredis supports call(); older minimal facades safely retain foreign
      // consumers rather than using a destructive, non-atomic fallback.
      if (typeof client.call === 'function') {
        await client.call(
          'EVAL',
          SWEEP_CONSUMERS,
          '1',
          topic,
          group,
          self,
          String(this.#consumerIdleSweepMs),
        );
      }
      return;
    }
    const consumers = await client.xinfo('CONSUMERS', topic, group);
    for (const fields of consumers) {
      if (!active()) return;
      const info: Record<string, unknown> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        if (typeof key === 'string') {
          Object.defineProperty(info, key, { value: fields[i + 1], enumerable: true });
        }
      }
      if (info.pending !== 0 || typeof info.name !== 'string') continue;
      if (info.name === self) {
        await client.xgroup('DELCONSUMER', topic, group, info.name);
      }
    }
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
   * @returns The reply payload
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
}
