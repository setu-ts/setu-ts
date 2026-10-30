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
import {
  createCachedProbe,
  OptionalDependencyUnavailableError,
  resolveProbeTiming,
  withDeadline,
} from '@setu-ts/common';
import {
  minimumStartOffsets,
  partitionsToSeek,
  isKafkaStartModule,
  optionalKafkaStartModule,
  startAwareRoundRobin,
} from './kafka-start-offsets.ts';
import type { IKafkaStartModule, KafkaStartOffsets } from './kafka-start-offsets.ts';
import type { PartitionAssigner } from 'kafkajs';
import { resolvePublishTimeoutMs } from './publish-timeout.ts';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { normalizeTransportHeaders } from './header-normalize.ts';
import { buildTransportHeaders, validatePublishOptions } from './publish-options.ts';
import type { ReplyInbox } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { ReconnectSupervisor } from '@setu-ts/common';
import type { IKafkaEventEmitter, IKafkaFactory, KafkaOptions } from '../interfaces/index.ts';
import { KafkaTopicUnavailableError, PublishTimeoutError } from '../errors.ts';
import { describeError } from './describe-error.ts';

/** Reply topic used when {@link KafkaOptions.replyTopic} is omitted. */
const DEFAULT_REPLY_TOPIC = 'messaging.replies';

/**
 * The wire value of kafkajs's `producer.events.DISCONNECT`. The `events` map's
 * KEYS (`CONNECT`, `DISCONNECT`, …) are not valid listener names — kafkajs
 * validates the string against the values and throws
 * `KafkaJSNonRetriableError: Event name should be one of producer.events.*`
 * for a key (X28-1). Declared as a literal, not read off `producer.events`
 * with a `??` fallback, so a fake that does not model `events` cannot satisfy
 * the assertion silently: `test/unit/kafka-real-import.test.ts` pins the
 * literal against the real module's own map.
 */
export const KAFKA_PRODUCER_DISCONNECT = 'producer.disconnect';

/**
 * The wire value of kafkajs's `producer.events.CONNECT`. See
 * {@linkcode KAFKA_PRODUCER_DISCONNECT} for why this is a literal.
 */
export const KAFKA_PRODUCER_CONNECT = 'producer.connect';

/**
 * The wire value of kafkajs's `consumer.events.GROUP_JOIN`. A literal for the
 * reason {@linkcode KAFKA_PRODUCER_DISCONNECT} is; pinned against the real
 * module's own map by `test/unit/kafka-real-import.test.ts`.
 */
export const KAFKA_CONSUMER_GROUP_JOIN = 'consumer.group_join';

/**
 * Consumer-group prefix for reply inboxes. Each broker instance derives a
 * unique group from it so replies are delivered to every instance rather than
 * load-balanced across the shared default group.
 */
const REPLY_GROUP_PREFIX = 'rr-inbox-';

/**
 * Lazily load kafkajs at runtime.
 *
 * @returns The kafkajs module
 * @throws {Error} If the kafkajs package cannot be resolved
 */
async function loadKafkajs(): Promise<typeof import('kafkajs')> {
  try {
    return await import('kafkajs');
  } catch (error) {
    throw new OptionalDependencyUnavailableError('kafkajs', {
      requiredBy: '@setu-ts/messaging-plugin',
      cause: error,
    });
  }
}

/**
 * Structural validation for Kafka factory.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IKafkaFactory {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['producer', 'consumer'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the Kafka factory: prefer injected client, then lazy-load kafkajs.
 *
 * @param brokers - Kafka bootstrap brokers
 * @param clientId - Kafka client ID
 * @param injectedClient - Optionally injected Kafka factory
 * @param retry - kafkajs retry policy for a lazily built client
 * @returns The resolved factory
 * @throws {Error} If no client injected and kafkajs cannot be loaded
 */
async function resolveClient(
  brokers: readonly string[],
  clientId: string,
  injectedClient?: IKafkaFactory,
  retry?: KafkaOptions['retry'],
): Promise<{
  factory: IKafkaFactory;
  probeAdmin: IKafkaAdmin | null;
  startModule: IKafkaStartModule | null;
}> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected Kafka client does not match the required structural shape ' +
          '(needs: producer, consumer)',
      );
    }
    return {
      factory: injectedClient,
      startModule: await optionalKafkaStartModule(loadKafkajs),
      probeAdmin:
        typeof injectedClient.admin === 'function'
          ? (injectedClient.admin({ retry: { retries: 0 } }) as IKafkaAdmin)
          : null,
    };
  }
  const kafkajs = await loadKafkajs();
  // M101b: `retry` is forwarded verbatim — kafkajs owns the metadata retry,
  // so the broker adds no loop of its own.
  const kafka = new kafkajs.Kafka({
    clientId,
    brokers: brokers as string[],
    ...(retry !== undefined ? { retry } : {}),
  });
  const healthKafka = new kafkajs.Kafka(kafkaHealthClientConfig(brokers, clientId));
  return {
    factory: kafka,
    probeAdmin: healthKafka.admin(),
    startModule: isKafkaStartModule(kafkajs) ? kafkajs : null,
  };
}

/**
 * Builds the dedicated short-timeout metadata client; never changes producer retries.
 * @param brokers - Bootstrap addresses
 * @param clientId - Main client ID, suffixed with -health
 * @returns The separate metadata client configuration
 */
export function kafkaHealthClientConfig(
  brokers: readonly string[],
  clientId: string,
): {
  brokers: string[];
  clientId: string;
  retry: { retries: number };
  requestTimeout: number;
  connectionTimeout: number;
} {
  return {
    brokers: [...brokers],
    clientId: `${clientId}-health`,
    retry: { retries: 0 },
    requestTimeout: 1500,
    connectionTimeout: 1000,
  };
}

/** Internal subset of the admin shared by real and injected factories. Offsets are strings. */
interface IKafkaAdmin {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  describeCluster(): Promise<unknown>;
  fetchOffsets(options: { groupId: string; topics: string[] }): Promise<
    Array<{
      topic: string;
      partitions: Array<{ partition: number; offset: string }>;
    }>
  >;
  fetchTopicOffsets(topic: string): Promise<Array<{ partition: number; offset: string }>>;
  describeGroups(
    groups: string[],
  ): Promise<{ groups: Array<{ members: Array<{ memberMetadata: Uint8Array }> }> }>;
}

/** A request timeout, including a retrier's bounded cause chain, cannot prove unreachability. */
function isRequestTimeout(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null; depth++) {
    if (typeof current !== 'object') return false;
    if ((current as { name?: unknown }).name === 'KafkaJSRequestTimeoutError') return true;
    current = (current as { cause?: unknown }).cause ?? null;
  }
  return false;
}

/** kafkajs's protocol error type for a topic the broker does not know. */
const UNKNOWN_TOPIC_TYPE = 'UNKNOWN_TOPIC_OR_PARTITION';

/** How many `cause` links to follow when classifying a kafkajs error. */
const MAX_CAUSE_DEPTH = 5;

/**
 * How long releasing a consumer waits for an in-flight group join to settle
 * (M101b security audit F3, N1). A join is a few ms on a broker with
 * `group.initial.rebalance.delay.ms=0` and about 3 s with Kafka's default.
 * The bound applies to the WAIT only: a join still pending when it passes is
 * not disconnected then — disconnecting under a join neither stops a join that
 * later succeeds nor returns before kafkajs's pending JoinGroup is answered —
 * but the moment it settles, after the release has returned.
 */
const JOIN_SETTLE_TIMEOUT_MS = 10_000;

/**
 * How long `disconnect()` waits for the producer to close. kafkajs's
 * `producer.disconnect()` first waits for every pending request — up to its
 * 30 s request timeout against a hung broker — so an unbounded wait held
 * `app.stop()` for ~26 s whenever sends were in flight. The close continues
 * after the bound; see {@link KafkaBroker.disconnect}.
 */
const PRODUCER_RELEASE_TIMEOUT_MS = 10_000;

/**
 * kafkajs's consumer `retry` default (`kafkajs/src/index.js:149`), which any
 * consumer-level `retry` REPLACES. Passed beside the restart hook so the
 * consumer keeps the retry count it had before the hook existed (M101b
 * security audit O5).
 */
const KAFKAJS_CONSUMER_RETRIES = 5;

/**
 * The delay before restarting a crashed consumer, read the way kafkajs's own
 * restart reads it (`kafkajs/src/consumer/index.js:293`,
 * `e.retryTime || retry.initialRetryTime || 300`): the crash's own positive
 * `retryTime`, else a positive `fallback`, else kafkajs's 300 ms default. A
 * configured `initialRetryTime: 0` therefore never means "restart at once" —
 * against a broker that is down that would spin (M101b security audit N3).
 *
 * @param error - The crash kafkajs reported
 * @param fallback - The configured initial retry time
 * @returns The delay in milliseconds
 */
function restartDelay(error: unknown, fallback: number): number {
  let retryTime: unknown;
  try {
    retryTime = (error as { retryTime?: unknown } | null)?.retryTime;
  } catch {
    // A throwing getter must not escape kafkajs's crash handler, where it
    // would become an unhandled rejection (plan §10 obligation 6).
    retryTime = undefined;
  }
  if (typeof retryTime === 'number' && Number.isFinite(retryTime) && retryTime > 0) {
    return retryTime;
  }
  return fallback > 0 ? fallback : DEFAULT_SUBSCRIBE_RETRY.initialRetryTime;
}

/**
 * The subscribe-retry budget when {@link KafkaOptions.retry} leaves a field
 * out — kafkajs's own defaults (`src/retry/defaults.js`), so one set of
 * numbers means the same thing to both.
 */
const DEFAULT_SUBSCRIBE_RETRY = {
  retries: 5,
  initialRetryTime: 300,
  multiplier: 2,
  maxRetryTime: 30_000,
} as const;

/** The resolved, validated subscribe-retry budget. */
interface SubscribeRetryBudget {
  readonly retries: number;
  readonly initialRetryTime: number;
  readonly multiplier: number;
  readonly maxRetryTime: number;
}

/**
 * Resolves and validates the subscribe-retry budget (M101b). Refused at
 * construction rather than at the first subscribe: a `NaN` — what
 * `Number(env.X)` yields for an unset variable — would make `attempt >= NaN`
 * false forever, an unbounded loop.
 *
 * @param retry - The configured policy
 * @returns The budget with kafkajs's defaults filled in
 * @throws {Error} When a field is out of range
 */
function resolveSubscribeRetry(retry: KafkaOptions['retry']): SubscribeRetryBudget {
  const budget: SubscribeRetryBudget = { ...DEFAULT_SUBSCRIBE_RETRY, ...retry };
  const refuse = (field: string, rule: string): never => {
    throw new Error(`KafkaOptions.retry.${field} must be ${rule}.`);
  };
  if (!Number.isInteger(budget.retries) || budget.retries < 0) {
    refuse('retries', 'a non-negative integer');
  }
  if (!Number.isFinite(budget.initialRetryTime) || budget.initialRetryTime < 0) {
    refuse('initialRetryTime', 'a finite, non-negative number of ms');
  }
  if (!Number.isFinite(budget.multiplier) || budget.multiplier < 1) {
    refuse('multiplier', 'a finite number of at least 1');
  }
  if (!Number.isFinite(budget.maxRetryTime) || budget.maxRetryTime < 0) {
    refuse('maxRetryTime', 'a finite, non-negative number of ms');
  }
  // `factor` is not read by the subscribe loop; it is forwarded to kafkajs as
  // the jitter of ITS retries, which draw each delay from
  // `[t - factor·t, t + factor·t]`. A NaN, non-finite or negative factor — or
  // one above 1, which draws negative delays — made those retries run back to
  // back (security audit F2), so it is held to [0, 1].
  const factor = retry?.factor;
  if (factor !== undefined && (!Number.isFinite(factor) || factor < 0 || factor > 1)) {
    refuse('factor', 'a finite number between 0 and 1');
  }
  return budget;
}

/**
 * Reports whether a kafkajs error (or one of its causes) is an unknown-topic
 * protocol error. Measured against kafkajs 2.2.4, `subscribe` rejects with the
 * bare `KafkaJSProtocolError` (its metadata retrier `bail`s every error but
 * `LEADER_NOT_AVAILABLE`); kafkajs's retrier wraps an error it DID retry in
 * `KafkaJSNumberOfRetriesExceeded` with the original as `cause`, so the chain
 * is walked, bounded, in case a later kafkajs retries this one too.
 *
 * Measured against Kafka 4.0 (KRaft) with `auto.create.topics.enable=true`:
 * the metadata request that TRIGGERS auto-creation answers this error, and the
 * topic exists a moment later — so it is the broker's to retry, not to name
 * at once.
 *
 * @param err - The rejection from `consumer.subscribe`
 * @returns `true` when the topic is unknown to the broker
 */
function isUnknownTopicError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null; depth++) {
    if (typeof current !== 'object') return false;
    if ((current as { type?: unknown }).type === UNKNOWN_TOPIC_TYPE) return true;
    current = (current as { cause?: unknown }).cause ?? null;
  }
  return false;
}

/**
 * Internal consumer entry.
 */
interface ActiveConsumer {
  id: string;
  consumer: unknown;
  running: boolean;
  /**
   * Settles once the consumer's latest `run()` has — that is, once kafkajs
   * has finished its group join or run its crash handler. Never rejects.
   */
  started: Promise<void>;
  /** Starts consumption again after a crash; replaces {@link started}. */
  run: () => void;
  /** The restart scheduled after a crash, while it has not begun. */
  restartTimer: { handle: unknown } | null;
  /**
   * The release in progress, once one has begun. `disconnect()` releases the
   * reply-inbox consumer through `unsubscribe()` AND through its own sweep at
   * the same time, so a second release returns the first rather than
   * disconnecting the consumer twice.
   */
  release: Promise<void> | null;
}

/**
 * Derives the per-topic default consumer group for a subscription that names
 * no `queue`.
 *
 * **Why per topic (M90d / X28, measured against a real broker):** a consumer
 * group's members must subscribe the SAME topics. When they differ, kafkajs
 * logs "Consumer group received unsubscribed topics" and BOTH members end
 * with an EMPTY assignment — so the single shared default group silently
 * stopped ALL delivery for any application subscribed to two topics,
 * including RPC, whose responder subscribes the derived `rr.req.<topic>`
 * channel. The same topic across instances still load-balances, because the
 * derived name is identical.
 *
 * **Why a colon (M90d review):** `${prefix}-${topic}` is not injective —
 * `('orders-eu', 'created')` and `('orders', 'eu-created')` both yield
 * `orders-eu-created`, which puts two differently-subscribed consumers back
 * into one group and restores the very failure above. Probed against a real
 * broker: a topic name containing `:` is REFUSED at creation, while a group
 * id containing `:` is accepted and reaches `Stable`. So the pair is
 * recoverable by splitting at the last colon, no two distinct pairs with
 * legal topic names can collide, and the name stays readable in
 * `kafka-consumer-groups.sh` output.
 *
 * @param defaultQueue - The configured group prefix
 * @param topic - The topic being subscribed
 * @returns The derived group id
 */
function deriveDefaultGroupId(defaultQueue: string, topic: string): string {
  return `${defaultQueue}:${topic}`;
}

/**
 * Kafka message broker implementation.
 *
 * @since 0.1.0
 */
export class KafkaBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #brokers: readonly string[];
  #clientId: string;
  #injectedClient: IKafkaFactory | undefined;
  #defaultQueue: string;
  #replyTopic: string;
  #retry: KafkaOptions['retry'];
  #subscribeRetry: SubscribeRetryBudget;
  /** Advanced by `disconnect()`, so a subscribe retry waiting across it stops (M101b). */
  #generation = 0;
  /** Cancels each pending subscribe-retry wait, so `disconnect()` holds no timer open. */
  #retryWaits = new Set<() => void>();
  #logger: KafkaOptions['logger'];
  #publishTimeoutMs: number;
  #startModule: IKafkaStartModule | null = null;
  #probeAdmin: IKafkaAdmin | null = null;
  #groupAdmin: IKafkaAdmin | null = null;
  #groupAdminConnect: Promise<void> | null = null;
  #probe: (() => Promise<boolean | undefined>) | null = null;
  #factory: IKafkaFactory | null = null;
  #producer: unknown | null = null;
  /** The underlying `producer.send()` calls not yet settled, bound or not. */
  #inFlightSends = new Set<Promise<unknown>>();
  #ready = false;
  #activeConsumers: Map<string, ActiveConsumer>;
  #rr: RequestReplyCore;
  #supervisor: ReconnectSupervisor;

  /**
   * Creates a new Kafka broker.
   *
   * @param runtime - Runtime services for uuid, timestamps, and timers
   * @param serializer - Serializer for message payloads
   * @param options - Kafka connection and configuration options
   */
  constructor(runtime: IRuntimeServices, serializer: ISerializer, options?: KafkaOptions) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#brokers = options?.brokers ?? ['localhost:9092'];
    this.#clientId = options?.clientId ?? 'messaging-client';
    this.#injectedClient = options?.client;
    this.#defaultQueue = options?.defaultQueue ?? 'messaging-consumers';
    this.#replyTopic = options?.replyTopic ?? DEFAULT_REPLY_TOPIC;
    this.#retry = options?.retry;
    this.#subscribeRetry = resolveSubscribeRetry(options?.retry);
    this.#logger = options?.logger;
    this.#publishTimeoutMs = resolvePublishTimeoutMs(options?.publishTimeoutMs);
    this.#activeConsumers = new Map();
    this.#rr = new RequestReplyCore({
      publish: (topic, message, headers) => this.publishWithHeaders(topic, message, headers ?? {}),
      subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
      uuid: () => this.#runtime.uuid(),
      setTimeout: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => this.#runtime.clearTimeout(handle),
      openInbox: (onReply) => this.#openReplyInbox(onReply),
    });
    this.#supervisor = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: (onFault) =>
        this.#attachProducerEvent(KAFKA_PRODUCER_DISCONNECT, onFault),
      attachRecoveryListener: (onRecovered) =>
        this.#attachProducerEvent(KAFKA_PRODUCER_CONNECT, onRecovered),
    });
  }

  /**
   * Opens this broker's reply inbox on the shared reply topic.
   *
   * Kafka cannot use the per-instance topic {@link createTopicInbox} mints: a
   * topic here is a durable, partitioned cluster resource; the broker's admin
   * is used only for metadata and group offsets. Instead every instance
   * reads ONE reply topic under a consumer group unique to itself, so delivery
   * is exclusive rather than load-balanced across the shared default group.
   * Replies addressed to other instances arrive here too and are dropped by
   * correlation-id lookup, which costs O(instances) fan-out but needs no admin
   * API and leaves no topic behind — only a consumer group, which Kafka expires
   * on `offsets.retention.minutes`.
   *
   * @param onReply - Invoked per message delivered to the reply topic
   * @returns The open inbox, addressed at the shared reply topic
   */
  async #openReplyInbox(onReply: (message: unknown) => void): Promise<ReplyInbox> {
    const subscription = await this.subscribe(
      this.#replyTopic,
      (message) => {
        onReply(message);
      },
      { queue: `${REPLY_GROUP_PREFIX}${this.#runtime.uuid()}` },
    );

    return {
      address: this.#replyTopic,
      close: (): Promise<void> => subscription.unsubscribe(),
    };
  }

  /**
   * Connects to Kafka and creates producer.
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    const resolved = await resolveClient(
      this.#brokers,
      this.#clientId,
      this.#injectedClient,
      this.#retry,
    );
    this.#factory = resolved.factory;
    this.#startModule = resolved.startModule;
    this.#probeAdmin = resolved.probeAdmin;

    // Build producer unconditionally from the resolved factory
    const realFactory = this.#factory as unknown as { producer(): unknown };
    this.#producer = realFactory.producer();
    await (this.#producer as unknown as { connect(): Promise<void> }).connect();
    const admin = this.#probeAdmin;
    if (admin !== null) {
      try {
        await admin.connect();
      } catch (error) {
        // The producer is already connected: release it, or a failed start()
        // leaves a live connection that keeps the process running (M101b class).
        try {
          await (this.#producer as unknown as { disconnect(): Promise<void> }).disconnect();
        } catch {
          // The admin failure is what the caller needs.
        }
        this.#producer = null;
        this.#factory = null;
        this.#probeAdmin = null;
        throw error;
      }
      this.#probe = createCachedProbe<boolean | undefined>({
        probe: async () => {
          try {
            await admin.describeCluster();
            return true;
          } catch (error) {
            return isRequestTimeout(error) ? undefined : false;
          }
        },
        fallback: undefined,
        ttlMs: 5000,
        timeoutMs: 2000,
        ...resolveProbeTiming(this.#runtime),
      });
    }

    this.#ready = true;
    this.#supervisor.start();
  }

  /**
   * Disconnects from Kafka.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  async disconnect(): Promise<void> {
    this.#supervisor.stop();
    this.#probe = null;
    // M101b: end every subscribe retry waiting out its backoff now, rather
    // than leaving its timer to hold the process for up to `maxRetryTime`.
    this.#generation++;
    for (const cancel of this.#retryWaits) cancel();
    this.#retryWaits.clear();
    // Reject in-flight requests and close the reply inbox before the transport
    // goes away, so no timer or subscription outlives the connection.
    //
    // Disconnect every active consumer. kafkajs's `stop()` only halts fetching
    // and leaves the consumer's cluster connection open, which kept the process
    // alive after `app.stop()` (measured on a real broker); `disconnect()` stops
    // AND closes it (M101b review). Released CONCURRENTLY — with each other AND
    // with the reply inbox's close, which releases the inbox consumer through
    // `unsubscribe()`: each release may wait for an in-flight join, and waiting
    // in turn would let N stalled joins hold shutdown for N times the bound
    // (PR #404 review). The inbox consumer is in both sets; `#releaseConsumer`
    // is memoized, so it is still disconnected once. Neither `rr.close()` nor
    // a release rejects into here: both swallow their own failures.
    await Promise.allSettled([
      this.#rr.close(),
      ...[...this.#activeConsumers.values()].map((consumer) => this.#releaseConsumer(consumer)),
    ]);
    this.#activeConsumers.clear();

    // A group admin may still be connecting for a subscribe racing shutdown.
    await this.#groupAdminConnect?.catch(() => {});
    await Promise.allSettled([this.#probeAdmin?.disconnect(), this.#groupAdmin?.disconnect()]);
    this.#probeAdmin = null;
    this.#groupAdmin = null;
    this.#groupAdminConnect = null;

    if (this.#producer) {
      await this.#releaseProducer(this.#producer as unknown as { disconnect(): Promise<void> }, [
        ...this.#inFlightSends,
      ]);
    }
    this.#producer = null;
    this.#factory = null;
    this.#ready = false;
  }

  /**
   * Records an underlying `send()` until it settles. A publish rejected at
   * `publishTimeoutMs` leaves its send running inside kafkajs; shutdown needs
   * to know it is still there.
   */
  #trackSend<T>(send: Promise<T>): Promise<T> {
    this.#inFlightSends.add(send);
    const settle = (): void => {
      this.#inFlightSends.delete(send);
    };
    send.then(settle, settle);
    return send;
  }

  /**
   * Closes the producer within {@link PRODUCER_RELEASE_TIMEOUT_MS}, and closes it
   * AGAIN once every send in flight at shutdown has settled.
   *
   * Two kafkajs behaviours, both measured against a paused Kafka 4.0: its
   * `disconnect()` waits for pending requests (up to the 30 s request timeout),
   * and a send abandoned at its bound keeps retrying after the disconnect and
   * reopens connections nothing closes again — the process then never exits.
   * The second `disconnect()` after the sends settle is what closes those; on a
   * healthy broker it finds nothing to close.
   */
  async #releaseProducer(
    producer: { disconnect(): Promise<void> },
    inFlight: readonly Promise<unknown>[],
  ): Promise<void> {
    const release = producer.disconnect().catch(() => {});
    let timer: unknown;
    const released = await Promise.race([
      release.then(() => true),
      new Promise<false>((resolve) => {
        timer = this.#runtime.setTimeout(() => resolve(false), PRODUCER_RELEASE_TIMEOUT_MS);
      }),
    ]);
    this.#runtime.clearTimeout(timer);
    if (inFlight.length > 0 || !released) {
      void Promise.allSettled([release, ...inFlight])
        .then(() => producer.disconnect())
        .catch(() => {});
    }
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
   * Faulted supervisor → false immediately. Otherwise a dedicated admin's
   * describeCluster round trip is cached for 5 s and bounded at 2 s. A
   * KafkaJSRequestTimeoutError (including a nested cause) or an expired bound
   * yields undefined; other errors yield false. Without admin on an injected
   * factory reachability is unknown. Injected admin timeouts are the application's.
   *
   * @returns `true`/`false`/`undefined` as described
   * @since 0.1.0
   */
  reachability(): Promise<boolean | undefined> {
    if (this.#supervisor.faulted) {
      return Promise.resolve(false);
    }
    return this.#probe?.() ?? Promise.resolve(undefined);
  }

  /**
   * Boolean port member (M70c): `false` only when positively unreachable.
   *
   * @returns `true` when reachable or unprobeable, `false` when the fault
   *   window is active
   * @since 0.1.0
   */
  async isHealthy(): Promise<boolean> {
    const reachable = await this.reachability();
    return reachable !== false;
  }

  /**
   * Attaches a producer event listener and returns a disposer that removes
   * it. A producer without an event surface (a minimal injected fake) returns
   * a no-op disposer.
   */
  #attachProducerEvent(event: string, onEvent: () => void): () => void {
    const producer = this.#producer;
    if (producer === null || typeof (producer as IKafkaEventEmitter).on !== 'function') {
      return () => {};
    }
    const listener = (...args: unknown[]): void => {
      void args;
      onEvent();
    };
    (producer as IKafkaEventEmitter).on(event, listener);
    return (): void => {
      const p = this.#producer as
        | (IKafkaEventEmitter & {
            off?: (event: string, listener: (...args: unknown[]) => void) => void;
          })
        | null;
      if (p !== null && typeof p.off === 'function') {
        p.off(event, listener);
      }
    };
  }

  /**
   * Publishes a message to a topic.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic to publish to
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
    if (!this.#producer) {
      throw new Error('KafkaBroker is not connected');
    }
    const validated = await validatePublishOptions(options);
    const wireHeaders = buildTransportHeaders(validated, headers);
    const serialized = this.#serializer.serialize(message);

    const realProducer = this.#producer as unknown as {
      send(options: { topic: string; messages: unknown }): Promise<void>;
    };

    await withDeadline(
      () =>
        this.#trackSend(
          realProducer.send({
            topic,
            messages: [
              {
                value: serialized,
                // Kafka's native mapping: the message key decides the partition, so the
                // same ordering key reaches one partition and stays in publish order.
                ...(validated.orderingKey !== undefined ? { key: validated.orderingKey } : {}),
                headers: wireHeaders,
              },
            ],
          }),
        ),
      {
        timeoutMs: this.#publishTimeoutMs,
        onTimeout: () =>
          new PublishTimeoutError(
            `Kafka did not acknowledge the message published to ${JSON.stringify(topic)} within ${this.#publishTimeoutMs} ms (publishTimeoutMs); it may still be delivered`,
            { topic, timeoutMs: this.#publishTimeoutMs },
          ),
        timing: resolveProbeTiming(this.#runtime),
      },
    );
  }

  /**
   * Subscribes to a topic using a consumer group.
   *
   * @typeParam T - The message payload type
   * @param topic - The topic to subscribe to
   * @param handler - The handler to invoke for each message
   * @param options - Optional subscription options (queue for consumer group ID)
   * @returns The subscription handle
   * @since 0.1.0
   */
  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    if (!this.#factory) {
      throw new Error('KafkaBroker is not connected');
    }

    const subscriptionId = this.#runtime.uuid();
    // Captured before the first await, so a `disconnect()` racing this call is
    // seen by the retry loop however early it lands (M101b).
    const generation = this.#generation;
    const groupId = options?.queue ?? deriveDefaultGroupId(this.#defaultQueue, topic);

    let start: KafkaStartOffsets | null = null;
    let warned = false;
    const warn = (error: unknown): void => {
      if (warned) return;
      warned = true;
      try {
        const logger = this.#logger;
        (logger?.warn ?? logger?.error)?.call(
          logger,
          `Kafka start-offset setup for topic ${JSON.stringify(topic)} (group ${JSON.stringify(groupId)}): ${describeError(error)}`,
        );
      } catch {
        /* Reporting must remain non-fatal. */
      }
    };
    const startModule = this.#startModule;
    // Create consumer unconditionally from the resolved factory
    const realFactory = this.#factory as unknown as {
      consumer(options: {
        groupId: string;
        partitionAssigners?: PartitionAssigner[];
        retry: { retries: number; restartOnFailure(error: Error): Promise<boolean> };
      }): unknown;
    };
    // The broker owns crash restarts
    // (M101b security audit N2): kafkajs consults `restartOnFailure` only for
    // a retriable crash, after its crash handler has already stopped and
    // disconnected the consumer, and runs its own restart behind a timer and
    // a group join the broker cannot see — so a release during that join
    // could neither stop it (kafkajs's `stop()` drops a runner that is not yet
    // running) nor cancel it. The hook therefore always declines, and
    // schedules the broker's own restart while the consumer is still wanted.
    // An injected factory may ignore the field.
    const realConsumer = realFactory.consumer({
      groupId,
      ...(startModule
        ? { partitionAssigners: [startAwareRoundRobin(startModule, topic, () => start)] }
        : {}),
      retry: {
        retries: KAFKAJS_CONSUMER_RETRIES,
        restartOnFailure: (error: Error) => {
          // kafkajs consults this only from a running consumer's crash
          // handler, so `activeConsumer` (declared below) is always set.
          this.#scheduleRestart(activeConsumer, error);
          return Promise.resolve(false);
        },
      },
    });

    const consumerTyped = realConsumer as unknown as {
      connect(): Promise<void>;
      subscribe(options: { topic: string; fromBeginning?: boolean }): Promise<void>;
      run(options: {
        eachMessage: (data: {
          topic: string;
          partition: number;
          message: unknown;
        }) => Promise<void>;
      }): Promise<void>;
      on?(
        event: string,
        listener: (event: {
          payload: { memberAssignment: Record<string, number[]> };
        }) => Promise<void>,
      ): unknown;
      seek(options: { topic: string; partition: number; offset: string }): void;
      stop(): Promise<void>;
      disconnect(): Promise<void>;
    };

    try {
      await consumerTyped.connect();
      await this.#withSubscribeRetry(
        () => consumerTyped.subscribe({ topic, fromBeginning: false }),
        isUnknownTopicError,
        generation,
      );
      start = await this.#captureGroupStart(topic, groupId, warn, generation);
      // A disconnect() that landed while the consumer was connecting, or during
      // a first attempt that then succeeded, must not leave a consumer running
      // after shutdown (security audit O1). The catch below releases it.
      if (generation !== this.#generation) {
        throw new Error('KafkaBroker was disconnected while subscribing');
      }
    } catch (err) {
      // M101b (V8-26): a consumer that failed to join is released rather than
      // leaked, and an unknown topic is named instead of escaping as a raw
      // protocol error that names no topic.
      try {
        await consumerTyped.disconnect();
      } catch {
        // Best-effort; the original failure is what the caller needs.
      }
      if (isUnknownTopicError(err)) {
        throw new KafkaTopicUnavailableError(topic, groupId, err);
      }
      throw err;
    }

    // `partition` MUST come from the outer eachMessage payload (kafkajs's
    // `EachMessagePayload`), never off the message record: real `KafkaMessage`
    // carries no `partition`, so reading it there yields `undefined` and the
    // documented `partition:offset` identity degrades to `"undefined:<offset>"`
    // — colliding across partitions and breaking the de-duplication the
    // identity exists for (90d verification, Finding 1).
    const firstDelivered = new Map<number, string>();
    const eachMessage = async ({
      partition,
      message,
    }: {
      topic: string;
      partition: number;
      message: unknown;
    }): Promise<void> => {
      // A released consumer handles nothing (M101b security audit N2): a join
      // that settles after its release delivers before the deferred
      // disconnect stops it. Throwing leaves the offset uncommitted, so the
      // group redelivers the record to a member that is still wanted.
      if (!activeConsumer.running) {
        throw new Error('KafkaBroker released this consumer; the record is left uncommitted');
      }
      const msgTyped = message as unknown as {
        key: Uint8Array | null;
        value: Uint8Array | null;
        timestamp: string;
        headers?: Record<
          string,
          Uint8Array | string | readonly (Uint8Array | string)[] | undefined
        >;
        offset: string;
      };

      if (!firstDelivered.has(partition)) firstDelivered.set(partition, msgTyped.offset);
      const valueBytes = msgTyped.value ?? new Uint8Array(0);
      const content = new TextDecoder().decode(valueBytes);
      const deserialized = this.#serializer.deserialize<T>(content);

      const metadata: MessageMetadata = {
        topic,
        messageId: `${partition}:${msgTyped.offset}`,
        timestamp: new Date(parseInt(msgTyped.timestamp, 10)),
        // Dropping an undecodable value rather than throwing is load-bearing
        // here: this runs inside `eachMessage`, where a throw prevents the
        // offset commit and kafka redelivers the record — so one malformed
        // header from a foreign producer would become an unbounded loop.
        headers: normalizeTransportHeaders(msgTyped.headers),
      };

      // Handler success triggers auto-commit; failure prevents commit
      await handler(deserialized, metadata);
    };

    const activeConsumer: ActiveConsumer = {
      id: subscriptionId,
      consumer: realConsumer,
      running: true,
      started: Promise.resolve(),
      restartTimer: null,
      release: null,
      // `run()` can REJECT — kafkajs's crash handler rethrows a disconnect
      // that fails — and nothing else holds that promise, so an unread
      // rejection would be an unhandled rejection that terminates the
      // process. It is reported and the consumer marked stopped instead.
      run: () => {
        const runPromise = consumerTyped.run({ eachMessage });
        activeConsumer.started = runPromise.then(
          () => {},
          () => {},
        );
        runPromise.catch((err: unknown) => {
          activeConsumer.running = false;
          try {
            this.#logger?.error(
              `Kafka consumer for topic ${JSON.stringify(topic)} (group ${JSON.stringify(
                groupId,
              )}) stopped: ${describeError(err)}`,
            );
          } catch {
            // The logger is the last-resort sink; its own failure is swallowed.
          }
        });
      },
    };
    let firstJoin = true;
    consumerTyped.on?.(KAFKA_CONSUMER_GROUP_JOIN, async ({ payload }) => {
      if (!firstJoin) return;
      firstJoin = false;
      if (start === null || !activeConsumer.running) return;
      try {
        const admin = this.#groupAdmin!;
        const current = await admin.fetchOffsets({ groupId, topics: [topic] });
        let minimum = start;
        if (startModule !== null) {
          const { groups } = await admin.describeGroups([groupId]);
          minimum = minimumStartOffsets(
            start,
            topic,
            groups.flatMap((group) => group.members),
            startModule,
            warn,
          );
        }
        if (!activeConsumer.running || generation !== this.#generation) return;
        const uncommitted = new Set(
          current
            .filter((entry) => entry.topic === topic)
            .flatMap((entry) =>
              entry.partitions.filter((p) => p.offset === '-1').map((p) => p.partition),
            ),
        );
        // Decision and seeks are synchronous: no delivery can interleave.
        for (const { partition, offset } of partitionsToSeek(
          payload.memberAssignment[topic] ?? [],
          uncommitted,
          minimum,
          firstDelivered,
        )) {
          consumerTyped.seek({ topic, partition, offset });
        }
      } catch (error) {
        warn(error);
      }
    });
    this.#activeConsumers.set(subscriptionId, activeConsumer);
    activeConsumer.run();

    return {
      unsubscribe: async (): Promise<void> => {
        const consumer = this.#activeConsumers.get(subscriptionId);
        if (consumer) {
          try {
            // Each subscription owns its consumer, so unsubscribing must
            // release its connection too — this is also the path the RPC
            // reply inbox closes through (M101b review).
            await this.#releaseConsumer(consumer);
          } catch {
            // Ignore errors
          }
          this.#activeConsumers.delete(subscriptionId);
        }
      },
    };
  }

  /** Captures a fresh group’s watermarks before run; never writes committed offsets. */
  async #captureGroupStart(
    topic: string,
    groupId: string,
    warn: (error: unknown) => void,
    generation: number,
  ): Promise<KafkaStartOffsets | null> {
    const factory = this.#factory;
    if (typeof factory?.admin !== 'function') return null;
    try {
      if (this.#groupAdmin === null) {
        const created = factory.admin() as IKafkaAdmin;
        this.#groupAdmin = created;
        // A failed connect is forgotten, so the next subscribe tries again
        // instead of every later subscription inheriting one transient failure.
        this.#groupAdminConnect = created.connect().catch((error: unknown) => {
          if (this.#groupAdmin === created) {
            this.#groupAdmin = null;
            this.#groupAdminConnect = null;
          }
          throw error;
        });
      }
      const admin = this.#groupAdmin;
      await this.#groupAdminConnect;
      // On a broker whose group coordinator is not ready yet — the first group
      // on a fresh broker, measured on Kafka 4.0 — this read fails with
      // NOT_COORDINATOR. Returning null then skipped every message published
      // before the join. The watermarks are captured anyway: the first-join
      // step re-reads committed offsets and seeks only partitions still
      // uncommitted, so a group that turns out to be committed seeks nothing.
      let isNew = true;
      try {
        const offsets = await admin.fetchOffsets({ groupId, topics: [topic] });
        isNew = offsets.every((entry) => entry.partitions.every((p) => p.offset === '-1'));
      } catch (error) {
        warn(error);
      }
      if (isNew) {
        if (generation !== this.#generation) return null;
        // A fresh KRaft topic can exist before its leaders are ready for ListOffsets.
        const offsets = await this.#withSubscribeRetry(
          () => admin.fetchTopicOffsets(topic),
          (error) =>
            typeof error === 'object' &&
            error !== null &&
            'retriable' in error &&
            error.retriable === true,
          generation,
        );
        return Object.fromEntries(offsets.map(({ partition, offset }) => [partition, offset]));
      }
    } catch (error) {
      warn(error);
    }
    return null;
  }

  /**
   * Schedules the broker's own restart of a crashed consumer (M101b security
   * audit N2), after the delay kafkajs's restart would use.
   *
   * Called from kafkajs's `restartOnFailure`, which runs only for a retriable
   * crash and only once kafkajs has stopped and disconnected the consumer. A
   * released consumer is not restarted; a release before the timer fires
   * clears it, and one after it fires waits for the restart's
   * {@link ActiveConsumer.started}.
   *
   * @param entry - The crashed consumer's entry
   * @param error - The crash kafkajs reported
   */
  #scheduleRestart(entry: ActiveConsumer, error: Error): void {
    if (!entry.running) return;
    const delay = restartDelay(error, this.#subscribeRetry.initialRetryTime);
    // At most one restart is pending, and it is the one a release clears: a
    // replaced timer left running would start a consumer nothing tracks.
    if (entry.restartTimer !== null) this.#runtime.clearTimeout(entry.restartTimer.handle);
    entry.restartTimer = {
      handle: this.#runtime.setTimeout(() => {
        entry.restartTimer = null;
        entry.run();
      }, delay),
    };
  }

  /**
   * Releases a consumer: cancels a scheduled restart, waits for an in-flight
   * group join to settle — bounded by {@link JOIN_SETTLE_TIMEOUT_MS} — and
   * disconnects it (M101b security audit F3, N1, N2).
   *
   * kafkajs's `stop()` only stops a runner whose join has completed; for one
   * still joining it is a no-op that also DROPS kafkajs's only reference to
   * the runner. Disconnecting then closes the connections, but a join waiting
   * out a backoff holds none and later succeeds — leaving a consumer that runs
   * after shutdown and that nothing can stop. So the consumer is disconnected
   * only once its latest `run()` has settled; when the bound passes first, the
   * disconnect is deferred to that moment and this returns. `disconnect()`,
   * not `stop()`: it also closes the connection.
   *
   * Memoized per consumer: a second call returns the first release, so the
   * consumer is disconnected once however many paths release it.
   *
   * @param consumer - The consumer entry to release
   * @returns Resolves when the consumer is disconnected or the bound passes
   */
  #releaseConsumer(consumer: ActiveConsumer): Promise<void> {
    consumer.release ??= this.#release(consumer);
    return consumer.release;
  }

  /**
   * The single release of a consumer; see {@link KafkaBroker.#releaseConsumer}.
   *
   * @param consumer - The consumer entry to release
   */
  async #release(consumer: ActiveConsumer): Promise<void> {
    consumer.running = false;
    if (consumer.restartTimer !== null) {
      this.#runtime.clearTimeout(consumer.restartTimer.handle);
      consumer.restartTimer = null;
    }
    const started = consumer.started;
    const disconnect = (): Promise<void> =>
      (consumer.consumer as { disconnect(): Promise<void> }).disconnect();
    let handle: unknown;
    const settled = await Promise.race([
      started.then(() => true),
      new Promise<boolean>((resolve) => {
        handle = this.#runtime.setTimeout(() => resolve(false), JOIN_SETTLE_TIMEOUT_MS);
      }),
    ]);
    this.#runtime.clearTimeout(handle);
    if (settled) {
      await disconnect();
      return;
    }
    started.then(disconnect).catch(() => {});
  }

  /**
   * Retries subscribe-time operations within the validated {@link KafkaOptions.retry} budget.
   *
   * kafkajs does not retry `UNKNOWN_TOPIC_OR_PARTITION`, and a KRaft broker
   * that auto-creates answers exactly that to the request that creates the
   * topic — so without this a subscription to a topic that did not exist yet
   * died at boot on a broker that would have created it. kafkajs restores the
   * consumer's target topics when that error escapes, so subscribing the same
   * consumer again is safe. Any other error, or the budget running out, is
   * rethrown for the caller to classify.
   *
   * Watermark reads use the same backoff and cancellable wait, retrying only
   * errors with kafkajs's `retriable: true` property.
   *
   * @param operation - The subscribe or watermark read
   * @param shouldRetry - Classifies errors eligible for another attempt
   * @param generation - The connection generation `subscribe()` started in;
   *   a `disconnect()` since then ends the retry
   */
  async #withSubscribeRetry<T>(
    operation: () => Promise<T>,
    shouldRetry: (error: unknown) => boolean,
    generation: number,
  ): Promise<T> {
    const budget = this.#subscribeRetry;
    let delay = budget.initialRetryTime;
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (err) {
        if (!shouldRetry(err) || attempt >= budget.retries) {
          throw err;
        }
      }
      if (generation !== this.#generation) {
        throw new Error('KafkaBroker was disconnected while subscribing');
      }
      await new Promise<void>((resolve) => {
        const cancel = (): void => {
          this.#runtime.clearTimeout(handle);
          this.#retryWaits.delete(cancel);
          resolve();
        };
        const handle = this.#runtime.setTimeout(cancel, delay);
        this.#retryWaits.add(cancel);
      });
      if (generation !== this.#generation) {
        throw new Error('KafkaBroker was disconnected while subscribing');
      }
      delay = Math.min(delay * budget.multiplier, budget.maxRetryTime);
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
   * Sends a request and awaits its single correlated reply.
   *
   * Replies arrive on the shared reply topic ({@link KafkaOptions.replyTopic},
   * default `'messaging.replies'`), which **must exist** — this broker creates
   * no topics; its admin is used only for metadata and group offsets. Either
   * pre-create it or enable `auto.create.topics.enable`; otherwise the
   * underlying producer error surfaces from this call rather than hanging until
   * the timeout.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic a responder is listening on
   * @param message - The request payload
   * @param options - Reply timeout behavior
   * @returns The reply payload
   * @throws {RequestTimeoutError} When no reply arrives within `timeoutMs`
   * @throws {RemoteHandlerError} When the responder throws
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
   * Registers a responder for a request topic. The handler's resolved value is
   * sent back to the caller, correlated to the originating request.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - The request topic to respond on
   * @param handler - Invoked per request; its result is returned to the caller
   * @param options - Consumer group behavior (load-balance competing responders)
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
      handler as (message: unknown, metadata: MessageMetadata) => unknown | Promise<unknown>,
      options,
    );
  }
}
