/**
 * Internal and option types for the messaging plugin.
 *
 * @module
 */

import type {
  ConnectionErrorReporter,
  IIngressBehavior,
  MessageHandler,
  MessageMetadata,
  RegistryFactory,
  SubscribeOptions,
} from '@setu-ts/common';
import type { ISerializer } from '../serializers/serializer.ts';

/**
 * Structural type for Redis Streams client.
 *
 * This type defines the minimal Redis client interface needed for stream operations.
 *
 * @since 0.1.0
 */
export interface IRedisStreamsClient {
  /** Add a message to a stream. */
  xadd(
    name: string,
    id: string,
    data: string | Array<string>,
    ...args: string[]
  ): Promise<string>;
  /** Create or manage consumer groups. */
  xgroup(
    command: 'CREATE' | 'DELETE' | 'SETID' | 'DELCONSUMER',
    ...args: string[]
  ): Promise<string | number>;
  /** Read messages from consumer groups. */
  xreadgroup(...args: string[]): Promise<unknown[][] | null>;
  /** Extended PEL query: [id, owner, idle milliseconds, delivery count]. */
  xpending(...args: string[]): Promise<Array<[string, string, number, number]>>;
  /** Atomically claims idle entries, returning [id, field/value list]. */
  xclaim(...args: string[]): Promise<Array<[string, string[]] | null>>;
  /** Consumer information as alternating field/value arrays (ioredis RESP2). */
  xinfo(...args: string[]): Promise<unknown[][]>;
  /**
   * Optional ioredis command surface, used for an atomic foreign-consumer sweep.
   * Without it, foreign consumers are retained: a snapshot followed by
   * DELCONSUMER could drop work delivered in between. Self-cleanup still runs.
   */
  call?(command: string, ...args: string[]): Promise<unknown>;
  /** Acknowledge processed messages. */
  xack(name: string, group: string, ...ids: string[]): Promise<number>;
  /** Quit/close the connection. */
  quit(): Promise<void>;
  /** Connect to the server (optional, for lazy clients). */
  connect?(): Promise<void>;
  /**
   * Pings the server (optional, M70c). The broker's reachability probe calls
   * it; a client that does not expose it reports `unknown` reachability
   * rather than lying. The real ioredis adapter implements it.
   */
  ping?(): Promise<string>;
  /**
   * Connection status string (optional, M70c). ioredis reports `'ready'`,
   * `'connecting'`, `'reconnecting'`, `'end'`, …
   */
  status?: string;
}

/**
 * Structural type for AMQP 0-9-1 connection (RabbitMQ).
 *
 * This type defines the minimal RabbitMQ client interface needed for topic exchange operations.
 *
 * @since 0.1.0
 */
export interface IAmqpConnection {
  /** Create a channel. */
  createChannel(): Promise<unknown>;
  /**
   * Create a channel in publisher-confirm mode (optional).
   *
   * Real amqplib connections always have it. When present the broker
   * publishes on a confirm channel, so `publish()` resolves only once the
   * broker has accepted the message and rejects when it refuses it. A facade
   * without it keeps a plain channel — `publish()` then resolves before the
   * broker has stored anything — and the broker logs one warning saying so.
   *
   * @returns A channel whose `publish` takes a confirmation callback
   * @since 0.9.0
   */
  createConfirmChannel?(): Promise<unknown>;
  /** Close the connection. */
  close(): Promise<void>;
  /**
   * Registers a connection-level event listener (optional, M70c).
   *
   * amqplib's `ChannelModel` is an `EventEmitter`; the real adapter
   * implements this for `'error'` and `'close'`, which the broker's
   * reconnect supervisor listens on. A client without an event surface
   * omits it and reports `unknown` reachability.
   *
   * @param event - Event name (`'error'` or `'close'`)
   * @param listener - Invoked when the event fires
   */
  on?(event: string, listener: (err?: unknown) => void): void;
  /**
   * Removes a connection-level event listener (optional, M70c). Paired with
   * {@linkcode on}; the supervisor's `stop()` calls it so a reconnect cycle
   * accumulates no listeners. The real amqplib adapter implements it.
   *
   * @param event - Event name (`'error'` or `'close'`)
   * @param listener - The listener to remove
   */
  off?(event: string, listener: (err?: unknown) => void): void;
}

/**
 * Structural type for NATS connection.
 *
 * This type defines the minimal NATS client interface needed for JetStream operations.
 *
 * @since 0.1.0
 */
export interface INatsConnection {
  /** Get JetStream instance. */
  jetstream(): unknown;
  /** Get JetStream manager (async). */
  jetstreamManager(): Promise<unknown>;
  /** Close the connection. */
  close(): void;
  /**
   * True when the connection is closed (optional, M70c). The broker's
   * reachability probe requires `isClosed() === false` **and** a successful
   * `rtt()`. The real nats adapter implements it.
   */
  isClosed?(): boolean;
  /**
   * Measures round-trip time (optional, M70c). Resolving proves the server
   * answers; the probe bounds it with its timeout. The real nats adapter
   * implements it.
   */
  rtt?(): Promise<number>;
  /**
   * Connection status (optional, M70c). nats reports an enum such as
   * `CONNECTED` or `DISCONNECTED`.
   */
  status?(): unknown;
  /**
   * Registers a connection event listener (optional, M70c).
   *
   * The broker's reconnect supervisor listens on `Disconnect`/`Reconnect`
   * so `isHealthy` is truthful during the outage window. nats reconnects
   * itself; the supervisor only observes.
   */
  on?(event: string, listener: (...args: unknown[]) => void): void;
  /**
   * Removes a connection event listener (optional, M70c). Paired with
   * {@linkcode on}; the supervisor's `stop()` calls it so a reconnect cycle
   * accumulates no listeners. The real nats adapter implements it.
   */
  off?(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Structural type for Kafka client factory.
 *
 * This type defines the minimal Kafka client interface needed for producer/consumer operations.
 *
 * @since 0.1.0
 */
export interface IKafkaFactory {
  /** Create a producer. */
  producer(): unknown;
  /** Create a consumer. */
  consumer(options: { groupId: string }): unknown;
}

/**
 * Structural type for a kafkajs consumer or producer instance (M70c).
 *
 * kafkajs instances expose an `on(event, listener)` surface emitting
 * `producer.connect`, `producer.disconnect` (producer) and `consumer.crash`
 * (consumer) events — the VALUES of the module's `events` map. The map's
 * UPPERCASE KEYS (`CONNECT`, `DISCONNECT`, `CRASH`) are not accepted listener
 * names: kafkajs validates the string and throws
 * `KafkaJSNonRetriableError: Event name should be one of producer.events.*`
 * for a key (X28-1 — passing the keys is the defect that stopped the Kafka
 * broker starting at all). The broker's reconnect supervisor tracks the wire
 * values so `isHealthy` is truthful while the client self-heals.
 *
 * @since 0.1.0
 */
export interface IKafkaEventEmitter {
  /**
   * Registers an event listener.
   *
   * @param event - The wire event value (`'producer.connect'`,
   *   `'producer.disconnect'`, `'consumer.crash'`, …) — NOT the uppercase
   *   `events` map key
   * @param listener - Invoked when the event fires
   */
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Broker type identifier.
 *
 * @since 0.1.0
 */
export type MessagingBrokerType =
  | 'memory'
  | 'redis-streams'
  | 'rabbitmq'
  | 'nats'
  | 'kafka'
  | 'pubsub'
  | 'service-bus'
  | 'custom';

/**
 * Shared options present on every {@linkcode MessagingPluginOptions} arm.
 *
 * @since 0.1.0
 */
export interface MessagingCommonOptions {
  /**
   * Instance name for multi-instance support.
   */
  name?: string;

  /**
   * Serializer for message payloads.
   */
  serializer?: ISerializer;
  /** Whether to create producer and consumer spans when telemetry is available. */
  tracing?: boolean;
  /**
   * Subscriptions registered declaratively, as an alternative to calling
   * `broker.subscribe(topic, handler, options)` imperatively after `start()`.
   * Each entry — instance or `RegistryFactory` — produces one `subscribe()`
   * call, so a subscription can be declared where the plugin is composed
   * instead of after the application has started.
   *
   * Instance entries register during the plugin's `register()` phase,
   * identical to the imperative timing. Factory entries are resolved in the
   * `onInit` phase — the first at which the registry holds every capability —
   * and the plugin AWAITS each `subscribe()` there, so the subscription is
   * established before the application serves. A factory that throws rejects
   * `start()` with an error naming `MessagingPlugin({ subscriptions })` and
   * the entry's index in THIS declared array, not its position among the
   * factories.
   *
   * Because the arm sits on this shared interface, EVERY
   * `MessagingPluginOptions` union arm inherits it — the declarative form is
   * broker-agnostic, exactly like the imperative `subscribe()` it mirrors.
   *
   * @since 0.3.0
   */
  readonly subscriptions?: readonly SubscriptionEntry[];
  /**
   * Ingress behaviours wrapped around every subscription handler — the
   * messaging arm of the transport-neutral behaviour chain shared with the
   * websocket, queue, and scheduler plugins (`IIngressBehavior` in
   * `@setu-ts/common`).
   *
   * Each behaviour observes an `IngressContext` carrying `kind: 'messaging'`,
   * the topic as `name`, the delivered message as `payload`, and the
   * transport `headers` from `MessageMetadata` (absent when the transport
   * carried no channel — there is deliberately NO `attempt`: brokers
   * redeliver, but `MessageMetadata` exposes no delivery count), and runs in
   * declared order ahead of the handler. A behaviour that returns without calling `next()`
   * short-circuits: the handler never sees the message. A behaviour that
   * throws follows the messaging handler's existing rejection path. The chain
   * wraps SUBSCRIBE handlers only — `respond` (RPC) is deliberately not
   * chained and not armed in this milestone.
   *
   * With no behaviours configured, the broker chain is byte-identical to the
   * pre-arm behaviour: no `PipelinedBroker` decorator is applied at all.
   *
   * Instance entries are read by the chain at `register()`; factory entries
   * are resolved in the `onInit` phase and a throwing factory rejects
   * `start()` naming `MessagingPlugin({ behaviors })` and the entry's index
   * in THIS declared array.
   *
   * When an entry is a FACTORY, DELIVERY is held until `onInit` has resolved
   * the whole chain, so no message reaches a handler through a partial one.
   * A broker holding a backlog delivers the moment a consumer attaches, and
   * the gate covers every subscription — this plugin's declared entries and
   * any a later plugin makes imperatively through the resolved broker — which
   * is why no registration's timing has to change. It is released once and
   * costs nothing thereafter.
   *
   * @since 0.3.0
   */
  readonly behaviors?: readonly (IIngressBehavior | RegistryFactory<IIngressBehavior>)[];
  /**
   * Bounds a dispatch held on the behaviour-chain gate, which exists only when
   * a `RegistryFactory` behaviour is declared. A held dispatch that waits
   * longer than this rejects with `ChainGateTimeoutError`, whose message names
   * the likely cause (a plugin publishing during its own `register()`); the
   * gate itself is left in place, so later dispatches refuse the same way
   * rather than delivering through a partial chain.
   *
   * Default `10_000` ms. `0` disables the bound and restores the wait-forever
   * behaviour, for an application that would rather hang than fail. The value
   * must be a finite, non-negative number no greater than `2_147_483_647`:
   * `NaN`, a negative value, `Infinity`, or a larger value throws a `RangeError`
   * naming this option at registration,
   * when a behaviour factory arms the gate (`Infinity` does NOT mean
   * wait-forever — `0` does). Ignored entirely when no behaviour factory is
   * configured, because the gate is then never armed. Declared on this shared
   * base — never per-arm — since the gate exists for every broker.
   *
   * @since 0.4.0
   */
  readonly chainReadyTimeoutMs?: number;
}

/**
 * Options for the in-memory broker — the adapter behind the `memory` arm of
 * {@linkcode MessagingPluginOptions}, constructed by it and by applications
 * that build `InMemoryBroker` directly.
 *
 * @since 0.4.0
 */
export interface InMemoryBrokerOptions {
  /**
   * Called once per REJECTED subscription handler, with the error and the
   * message metadata of the failed dispatch. `publish` resolves on dispatch
   * hand-off — never on handler completion — so this reporter is the terminus
   * of the broker's failure path: the in-memory broker has no ack model and
   * no redelivery to fall back on (unlike RabbitMQ, where a rejection reaching
   * the broker's failure path can nack and redeliver). Absent, the rejection
   * is still observed and settled — never an unhandled rejection — then
   * dropped. A reporter that itself throws or rejects is swallowed by the broker: it is
   * the last-resort sink, so its own failure can neither reject `publish` nor
   * abort the sibling fan-out nor surface as an unhandled rejection.
   * `MessagingPlugin` always supplies one backed by the application's logger,
   * so the absent case is reachable only by constructing the broker directly.
   */
  readonly onDispatchError?: (
    error: unknown,
    metadata: MessageMetadata,
  ) => void | Promise<void>;
}

/**
 * The declarative form of one `IMessageBroker.subscribe()` call — the entry
 * an application writes instead of calling `subscribe()` imperatively after
 * `start()`.
 *
 * @since 0.3.0
 */
export interface SubscriptionDefinition {
  /** The topic to subscribe to (the `subscribe()` topic argument). */
  readonly topic: string;
  /** Invoked per delivered message, exactly as the imperative `subscribe()` accepts. */
  readonly handler: MessageHandler;
  /** Consumer-group configuration, exactly as the imperative `subscribe()` accepts. */
  readonly options?: SubscribeOptions;
}

/**
 * One entry of {@linkcode MessagingCommonOptions.subscriptions}: a
 * subscription definition, or a {@linkcode RegistryFactory} producing one
 * when the handler needs a resolved capability.
 *
 * @since 0.3.0
 */
export type SubscriptionEntry =
  | SubscriptionDefinition
  | RegistryFactory<SubscriptionDefinition>;

// ─── Arms of the discriminated union ───────────────────────────────────────────

/**
 * Default (memory) arm. The discriminant is optional so that `MessagingPlugin()`
 * and `MessagingPlugin({})` remain valid.
 *
 * @since 0.1.0
 */
export interface MemoryMessagingOptions extends MessagingCommonOptions {
  broker?: 'memory';
}

/**
 * Consumer delivery budget, tiered delays, and application failure classification.
 * Defaults and delivery lease semantics depend on the broker.
 * @since 0.9.0
 */
export interface ConsumerRetryOptions {
  /** Positive safe integer delivery budget, including the initial attempt. @since 0.9.0 */
  readonly maxAttempts?: number;
  /** Nonempty, nondecreasing positive integer milliseconds ≤2147483647. @since 0.9.0 */
  readonly delaysMs?: readonly number[];
  /** False dead-letters immediately; a throwing classifier is logged and retries. @since 0.9.0 */
  readonly isRetryable?: (error: unknown) => boolean;
}

/**
 * Redis Streams arm.
 *
 * @since 0.1.0
 */
export interface RedisStreamsMessagingOptions extends MessagingCommonOptions {
  /**
   * Consumer retry policy. maxAttempts includes the initial delivery (default 5).
   * delaysMs defaults to [30000, 60000, 300000, 600000]; a nonempty,
   * nondecreasing list of positive integer milliseconds ≤2147483647.
   * The first delay must exceed the longest handler run to avoid concurrent
   * processing by another replica. No false arm: failed messages are retried.
   * @since 0.9.0
   */
  consumerRetry?: ConsumerRetryOptions;
  /** Reclaim timer in positive integer ms ≤2147483647. Default 5000. @since 0.9.0 */
  reclaimIntervalMs?: number;
  /** Approximate DLQ MAXLEN, a positive safe integer. Default 10000. @since 0.9.0 */
  deadLetterMaxLen?: number;
  /** Foreign-consumer inactivity in positive integer ms ≤2147483647. Default 3600000. @since 0.9.0 */
  consumerIdleSweepMs?: number;

  broker: 'redis-streams';
  url?: string;
  client?: IRedisStreamsClient;
  defaultQueue?: string;
  pollIntervalMs?: number;
  blockSizeMs?: number;
}

/**
 * RabbitMQ arm.
 *
 * @since 0.1.0
 */
export interface RabbitMqMessagingOptions extends MessagingCommonOptions {
  /**
   * Durable group retries; false retains nack-and-discard for operator DLX policies.
   * Default maxAttempts 5, delaysMs [5000, 30000, 120000, 600000].
   * Deterministic failures dead-letter immediately. Private queues and RPC reply inboxes discard.
   * With retries enabled, group suffixes .dead and .retry.<digits>ms are reserved.
   * Generated helper names must fit 255 UTF-8 bytes; injected channels need confirms and returns.
   * @since 0.9.0
   */
  consumerRetry?: false | ConsumerRetryOptions;
  /**
   * Q.dead retention cap (positive safe integer, default 10000).
   * Changing it requires draining and deleting the existing dead queue before restart.
   * @since 0.9.0
   */
  deadLetterMaxLength?: number;
  /** Per-consumer unacked delivery limit, integer 1–65535, default 32. @since 0.9.0 */
  prefetch?: number;
  broker: 'rabbitmq';
  url?: string;
  client?: IAmqpConnection;
  exchangeName?: string;
  defaultQueue?: string;
  /**
   * Publish every message persistent (`delivery_mode` 2). Default `true`.
   *
   * Consumer-group queues are declared durable, and a durable queue keeps
   * only PERSISTENT messages across a broker restart: before 0.9.0 every
   * message was published transient, so a RabbitMQ restart emptied every
   * queue of messages not yet consumed. `false` restores that behaviour, for
   * deliberately ephemeral traffic where losing in-flight messages on a
   * restart is acceptable in exchange for skipping the broker's disk write.
   *
   * @since 0.9.0
   */
  persistentMessages?: boolean;
  /**
   * Bound on one `publish()`, in milliseconds. Default `15000`; `0` waits
   * without a bound.
   *
   * It covers every broker round trip a publish makes — the exchange assert,
   * and, on a confirm channel (a real amqplib connection always opens one),
   * the wait for RabbitMQ to accept the message. `publish()` resolves once
   * RabbitMQ has accepted it, rejects when it refuses it or the channel closes
   * first, and rejects when the bound expires: a paused broker keeps its
   * socket open, so without a bound the call would stay pending forever. A
   * rejection is not proof the message was dropped — the broker may still
   * accept it after the bound. A value outside `0`–`2147483647` (including
   * `NaN`) throws `RangeError` when `MessagingPlugin(...)` is called.
   *
   * @since 0.9.0
   */
  publishTimeoutMs?: number;
}

/**
 * NATS arm.
 *
 * @since 0.1.0
 */
export interface NatsMessagingOptions extends MessagingCommonOptions {
  broker: 'nats';
  url?: string;
  client?: INatsConnection;
  /**
   * Factory building the NATS `MsgHdrs` used to carry transport headers.
   *
   * Required alongside {@link client} for trace propagation: an injected
   * connection carries no nats module, so the broker has no `headers()` to call.
   * A lazily-loaded connection supplies its own and needs nothing here.
   *
   * @example
   * ```typescript
   * import * as nats from 'npm:nats@2.x';
   * MessagingPlugin({ broker: 'nats', client, headersFactory: () => nats.headers() });
   * ```
   */
  headersFactory?: () => INatsHeaders;
  streamName?: string;
  /**
   * Subjects the broker may create {@link streamName} with when the stream is
   * absent on the server.
   *
   * There is deliberately NO default and no catch-all: NATS refuses a stream
   * capturing every subject unless it is created with `no_ack: true`, and
   * `no_ack` makes every JetStream publish reject unobserved (X28-2). Supplied
   * and the stream is absent → the broker creates it with exactly these
   * subjects. Absent and the stream is absent → startup rejects with
   * `JetStreamStreamError`, naming the stream and both remedies (create the
   * stream out of band, or supply this option). An existing stream is never
   * touched either way.
   *
   * @since 0.5.0
   * @example
   * ```typescript
   * MessagingPlugin({
   *   broker: 'nats',
   *   streamSubjects: ['orders.>', 'billing.>'],
   * });
   * ```
   */
  streamSubjects?: readonly string[];
  defaultQueue?: string;
}

/**
 * Kafka arm.
 *
 * @since 0.1.0
 */
export interface KafkaMessagingOptions extends MessagingCommonOptions {
  broker: 'kafka';
  brokers?: readonly string[];
  client?: IKafkaFactory;
  clientId?: string;
  defaultQueue?: string;
  replyTopic?: string;
  /** kafkajs retry policy; see {@linkcode KafkaOptions.retry}. */
  retry?: KafkaOptions['retry'];
}

/**
 * GCP Pub/Sub arm — injected transport variant.
 *
 * When {@link client} is provided, production credentials are not required.
 *
 * @since 0.1.0
 */
export interface PubSubMessagingOptionsInjected extends MessagingCommonOptions {
  broker: 'pubsub';
  /** Injected transport (bypasses lazy SDK load). Required for this arm. */
  client: import('../brokers/pubsub-broker.ts').IPubSubTransport;
  /** GCP project ID. Optional when {@link client} is injected. */
  projectId?: string;
  /** Service-account credentials. Optional when {@link client} is injected. */
  credentials?: unknown;
  defaultQueue?: string;
  replyTopic?: string;
}

/**
 * GCP Pub/Sub arm — production variant.
 *
 * Requires {@link projectId} and does NOT accept an injected {@link client}.
 *
 * @since 0.1.0
 */
export interface PubSubMessagingOptionsProduction extends MessagingCommonOptions {
  broker: 'pubsub';
  /** GCP project ID. Required for production. */
  projectId: string;
  /** Service-account credentials (object or key path). SDK ADC is used when omitted. */
  credentials?: unknown;
  /** Mutually exclusive with production arm — use {@link PubSubMessagingOptionsInjected} instead. */
  client?: never;
  defaultQueue?: string;
  replyTopic?: string;
}

/**
 * GCP Pub/Sub options — exclusive union of injected and production arms.
 *
 * @since 0.1.0
 */
export type PubSubMessagingOptions =
  | PubSubMessagingOptionsInjected
  | PubSubMessagingOptionsProduction;

/**
 * Azure Service Bus SDK retry budget for the data client (M90b / X28-6).
 *
 * Shape mirrors `@azure/service-bus`'s `RetryOptions`: `maxRetries`,
 * `retryDelayInMs`, `maxRetryDelayInMs`, `mode`, and `timeoutInMs`. It is
 * passed ONLY to `ServiceBusClient` — never to the administration client,
 * whose pipeline options are a different contract. Omission preserves the
 * Azure SDK default; `maxRetries: 0` is the documented short retry budget
 * for a deployment that must fail fast toward a dead broker rather than
 * hold a request for the 90 s default chain.
 *
 * @since 0.5.0
 */
export interface ServiceBusRetryOptions {
  /**
   * Maximum number of retry attempts before an operation fails.
   * The SDK default is `3`; `0` disables retries entirely.
   */
  readonly maxRetries?: number;
  /** Delay before the first retry, in milliseconds. The SDK default is `30000`. */
  readonly retryDelayInMs?: number;
  /** Ceiling the exponential backoff grows to, in milliseconds. The SDK default is `90000`. */
  readonly maxRetryDelayInMs?: number;
  /**
   * Backoff curve. Translated to the SDK's numeric `RetryMode` before
   * `ServiceBusClient` is constructed (the SDK compares the value with
   * `===` against its enum). The SDK default when omitted is `'fixed'`.
   */
  readonly mode?: 'fixed' | 'exponential';
  /** Whole-operation timeout, in milliseconds. The SDK default is `60000`. */
  readonly timeoutInMs?: number;
}

/**
 * Azure Service Bus arm — injected transport variant.
 *
 * When {@link client} is provided, production credentials are not required.
 *
 * @since 0.1.0
 */
export interface ServiceBusMessagingOptionsInjected extends MessagingCommonOptions {
  broker: 'service-bus';
  /** Injected transport (bypasses lazy SDK load). Required for this arm. */
  client: import('../brokers/service-bus-broker.ts').IServiceBusTransport;
  /** Connection string. Optional when {@link client} is injected. */
  connectionString?: string;
  adminConnectionString?: string;
  defaultQueue?: string;
  replyTopic?: string;
}

/**
 * Azure Service Bus arm — production variant.
 *
 * Requires {@link connectionString} and does NOT accept an injected {@link client}.
 *
 * @since 0.1.0
 */
export interface ServiceBusMessagingOptionsProduction extends MessagingCommonOptions {
  broker: 'service-bus';
  /** Connection string for the Service Bus namespace. Required for production. */
  connectionString: string;
  /** Connection string for the administration client. Defaults to {@link connectionString}. */
  adminConnectionString?: string;
  /** Mutually exclusive with production arm — use {@link ServiceBusMessagingOptionsInjected} instead. */
  client?: never;
  defaultQueue?: string;
  replyTopic?: string;
  /**
   * SDK retry budget for the data client (M90b / X28-6). Optional on the
   * production arm only — an injected transport owns its own client and its
   * retry configuration. Omitted preserves the Azure SDK default.
   *
   * @since 0.5.0
   */
  retryOptions?: ServiceBusRetryOptions;
}

/**
 * Azure Service Bus options — exclusive union of injected and production arms.
 *
 * @since 0.1.0
 */
export type ServiceBusMessagingOptions =
  | ServiceBusMessagingOptionsInjected
  | ServiceBusMessagingOptionsProduction;

/**
 * Custom (inject-any-broker) arm.
 *
 * @since 0.1.0
 */
export interface CustomMessagingOptions extends MessagingCommonOptions {
  broker: 'custom';
  instance: import('@setu-ts/common').IMessageBroker;
}

/**
 * Discriminated union of all broker option arms.
 *
 * The memory arm's `broker` is optional so that `{}` and `undefined` satisfy
 * the union, keeping the factory's own `= {}` default and every bare call
 * (`MessagingPlugin()`, `MessagingPlugin({})`) valid.
 *
 * @since 0.1.0
 */
export type MessagingPluginOptions =
  | MemoryMessagingOptions
  | RedisStreamsMessagingOptions
  | RabbitMqMessagingOptions
  | NatsMessagingOptions
  | KafkaMessagingOptions
  | PubSubMessagingOptions
  | ServiceBusMessagingOptions
  | CustomMessagingOptions;

/**
 * Redis-specific options (internal use).
 *
 * @since 0.1.0
 */
export interface RedisStreamsOptions {
  /** Shared retry shape used by the Redis plugin arm. */
  consumerRetry?: RedisStreamsMessagingOptions['consumerRetry'];
  /** Reclaim interval; see RedisStreamsMessagingOptions. */
  reclaimIntervalMs?: number;
  /** Approximate dead-letter retention; see RedisStreamsMessagingOptions. */
  deadLetterMaxLen?: number;
  /** Foreign idle-consumer sweep threshold; see RedisStreamsMessagingOptions. */
  consumerIdleSweepMs?: number;
  /** Redis connection URL. */
  url?: string;
  /** Injected Redis client. */
  client?: IRedisStreamsClient;
  /** Default consumer group name. */
  defaultQueue?: string;
  /** Poll interval in milliseconds. */
  pollIntervalMs?: number;
  /** Block timeout in milliseconds. */
  blockSizeMs?: number;
  /** Optional logger for error reporting. */
  logger?: { error: (msg: string) => void };
  /**
   * Receives the connection errors (`ioredis` `'error'` events) of the client
   * the broker BUILDS, instead of `ioredis` printing each reconnect failure to
   * the console. Never attached to an injected `client`, which belongs to the
   * caller. `MessagingPlugin` supplies one backed by its logger.
   *
   * @since 0.9.0
   */
  connectionErrorReporter?: ConnectionErrorReporter;
}

/**
 * RabbitMQ-specific options (internal use).
 *
 * @since 0.1.0
 */
export interface RabbitMqOptions {
  /** Durable group retry policy. See RabbitMqMessagingOptions. @since 0.9.0 */
  consumerRetry?: false | ConsumerRetryOptions;
  /** Dead queue retention cap, default 10000. @since 0.9.0 */
  deadLetterMaxLength?: number;
  /** Per-consumer delivery limit, default 32. @since 0.9.0 */
  prefetch?: number;
  /** RabbitMQ connection URL. */
  url?: string;
  /** Injected AMQP connection. */
  client?: IAmqpConnection;
  /** Exchange name (default: 'messaging'). */
  exchangeName?: string;
  /** Default consumer group/queue name. */
  defaultQueue?: string;
  /**
   * Mark every published message persistent (default `true`). See
   * {@linkcode RabbitMqMessagingOptions.persistentMessages}.
   */
  persistentMessages?: boolean;
  /**
   * Bound on one publish, including its confirm, in ms (default `15000`, `0`
   * unbounded). See {@linkcode RabbitMqMessagingOptions.publishTimeoutMs}.
   */
  publishTimeoutMs?: number;
  /** Optional logger for error reporting; `warn` is used when present. */
  logger?: { error: (msg: string) => void; warn?: (msg: string) => void };
}

/**
 * NATS-specific options (internal use).
 *
 * @since 0.1.0
 */
export interface NatsOptions {
  /** NATS connection URL(s). */
  url?: string;
  /** Injected NATS connection. */
  client?: INatsConnection;
  /** Factory for NATS headers when an application injects the connection. */
  headersFactory?: () => INatsHeaders;
  /** JetStream stream name (default: 'MESSAGING'). */
  streamName?: string;
  /**
   * Subjects the broker may create the stream with when it is absent (X28-2).
   * No default: with the stream absent and this unset, `connect()` throws
   * `JetStreamStreamError` naming both remedies. See
   * {@linkcode NatsMessagingOptions.streamSubjects} for the full behavior.
   *
   * @since 0.5.0
   */
  streamSubjects?: readonly string[];
  /** Default consumer group name. */
  defaultQueue?: string;
  /** Optional logger for error reporting. */
  logger?: { error: (msg: string) => void };
}

/** Public members used from NATS `MsgHdrs`. */
export interface INatsHeaders {
  /** Stores one header value. */
  set(key: string, value: string): void;
  /** Reads one header value. */
  get(key: string): string | undefined;
  /** Lists the header names. */
  keys(): Iterable<string>;
}

/**
 * Kafka-specific options (internal use).
 *
 * @since 0.1.0
 */
export interface KafkaOptions {
  /** Kafka bootstrap brokers. */
  brokers?: readonly string[];
  /** Injected Kafka factory. */
  client?: IKafkaFactory;
  /** Kafka client ID (default: 'messaging-client'). */
  clientId?: string;
  /** Default consumer group name. */
  defaultQueue?: string;
  /**
   * Retry budget (M101b). Forwarded verbatim to `new Kafka({ retry })`, where
   * kafkajs uses it for its own retries; and read by the broker to retry a
   * subscription whose topic the Kafka broker reports unknown.
   *
   * kafkajs does not retry `UNKNOWN_TOPIC_OR_PARTITION` (its metadata retrier
   * gives up on every error but `LEADER_NOT_AVAILABLE`), and a KRaft broker
   * with `auto.create.topics.enable` answers exactly that to the request that
   * creates the topic — measured on Kafka 4.0, the next attempt succeeds. So
   * `subscribe()` retries that one error with exponential backoff: `retries`
   * attempts after the first, waiting `initialRetryTime` and growing by
   * `multiplier` up to `maxRetryTime` — kafkajs's defaults, 5 / 300 ms / 2 /
   * 30 s, about 9 s in all. A topic still unknown after that rejects with
   * `KafkaTopicUnavailableError`; `retries: 0` names it at once. Every field
   * is validated at construction, `factor` (kafkajs's jitter) included, held
   * to [0, 1]. The forwarding to kafkajs is skipped when
   * {@link client} is injected (the application built that `Kafka`); the
   * subscribe retry applies either way.
   */
  retry?: {
    /** Maximum wait between retries, in ms (kafkajs default 30000). */
    maxRetryTime?: number;
    /** Initial wait, in ms (kafkajs default 300). */
    initialRetryTime?: number;
    /** Randomization factor, between 0 and 1 (kafkajs default 0.2). */
    factor?: number;
    /** Exponential growth factor (kafkajs default 2). */
    multiplier?: number;
    /** Maximum number of retries (kafkajs default 5). */
    retries?: number;
  };
  /**
   * Topic every request-reply response is published to and read back from.
   *
   * Kafka topics are durable cluster resources and this broker creates none, so
   * the topic must already exist (or `auto.create.topics.enable` must be on).
   * The same holds for every SUBSCRIBED topic: on a broker that does not
   * auto-create, subscribing a topic that does not exist makes `subscribe()`
   * (and so `start()` for a declared subscription) reject, once the
   * {@link retry} budget is spent, with `KafkaTopicUnavailableError` naming
   * the topic and the consumer group.
   * Each broker instance reads it under its own consumer group, so every
   * instance sees every reply and discards those it did not originate — give a
   * high-traffic service its own reply topic to bound that fan-out.
   *
   * @defaultValue `'messaging.replies'`
   */
  replyTopic?: string;
  /**
   * Optional logger. Reads a consumer whose `consumer.run()` rejects —
   * kafkajs's crash handler rethrows a disconnect that fails — which would
   * otherwise be an unhandled rejection.
   */
  logger?: { error: (msg: string) => void };
}

/**
 * Options for the EventsMessagingBridge factory.
 *
 * @since 0.1.0
 */
export interface EventsMessagingBridgeOptions {
  /**
   * The event types to forward to the messaging broker.
   */
  eventTypes: readonly string[];

  /**
   * The capability token for the messaging broker to use.
   *
   * @defaultValue `CAPABILITIES.MESSAGING` (`'messaging'`)
   */
  token?: string;

  /**
   * Function to map event types to broker topics.
   *
   * @defaultValue Identity function (event type becomes topic)
   */
  topicMapping?: (eventType: string) => string;

  /**
   * Custom error handler for publish failures.
   *
   * @defaultValue Logs via optional logger, then swallows
   */
  errorHandler?: (error: unknown, eventType: string) => void;
}
