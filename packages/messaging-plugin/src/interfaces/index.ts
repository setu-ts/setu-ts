/**
 * Internal and option types for the messaging plugin.
 *
 * @module
 */

import type {
  ConnectionErrorReporter,
  IInboxStore,
  IIngressBehavior,
  IOutboxStore,
  IOutboxWriteScope,
  MessageHandler,
  MessageMetadata,
  PublishOptions,
  RegistryFactory,
  SubscribeOptions,
} from '@setu-ts/common';
import type { IntegrationEventDefinition } from '../integration/definition.ts';
import type { IntegrationEventMetadata } from '../integration/publish.ts';
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
  /**
   * The transactional outbox (M107). When set, the plugin registers an
   * {@linkcode IOutbox} under `CAPABILITIES.OUTBOX` (`outbox.<name>` for a
   * named instance) and an `outbox` health indicator. At `onInit` it resolves
   * the store(s), runs each store's `verify()` — a refusal fails `start()` —
   * and, unless `relay.schedule` is `false`, schedules the relay
   * (`outbox-relay[.<name>]`, every `relay.intervalMs`) and the purge
   * (`outbox-purge[.<name>]`, every `purgeIntervalMs`) on
   * `CAPABILITIES.SCHEDULER`; with no scheduler registered `start()` rejects
   * `OutboxRelayUnscheduledError`. On shutdown the relay is drained in an
   * `onShutdown` hook, before any close hook — the broker's included.
   *
   * Every numeric option is validated when `MessagingPlugin(...)` is called.
   * Absent, nothing changes: no capability, hook, indicator or ordering edge
   * is added.
   *
   * @since 0.9.0
   */
  readonly outbox?: OutboxOptions;
  /**
   * The consumer inbox (M108). When set, the plugin registers an
   * {@linkcode IInbox} under `CAPABILITIES.INBOX` (`inbox.<name>` for a named
   * instance) and an `inbox` health indicator, so that
   * `onIntegrationEvent(definition, handler, { inbox: { consumer } })`
   * subscriptions apply each event's database writes once per consumer. At
   * `onInit` it resolves the store, runs its `verify()` — a refusal fails
   * `start()` — and, unless `purge.schedule` is `false`, schedules the
   * retention purge (`inbox-purge[.<name>]`) on `CAPABILITIES.SCHEDULER`;
   * with no scheduler registered `start()` rejects
   * `InboxPurgeUnscheduledError`. The inbox closes after the broker
   * disconnects, so no in-flight delivery is refused during a stop.
   *
   * Every numeric option is validated when `MessagingPlugin(...)` is called.
   * Absent, nothing changes: no capability, hook, indicator or ordering edge
   * is added.
   *
   * @since 0.9.0
   */
  readonly inbox?: InboxOptions;
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
   * Generated helper names must fit 255 UTF-8 bytes; a retrying group on an injected channel without
   * confirms and on/off return listeners is refused at subscribe().
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
  /**
   * Not accepted with an injected {@link client}: the broker creates
   * subscriptions through the injected transport, so it cannot switch ordering
   * on. Pass `enableMessageOrdering` to `adaptPubSubModule` when building the
   * transport instead.
   */
  enableMessageOrdering?: never;
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
  /**
   * Create the transport's own subscriptions with message ordering enabled
   * (default `false`), required before a native `orderingKey` is delivered in
   * order. Fixed at subscription creation and it costs throughput, so it is
   * opt-in (M106 §3.5).
   */
  enableMessageOrdering?: boolean;
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

// ─── Transactional outbox (M107) ───────────────────────────────────────────────

/**
 * One outbox store: an {@linkcode IOutboxStore} instance, or a
 * {@linkcode RegistryFactory} producing one (for example
 * `createDatabaseOutboxStore()` from `@setu-ts/database-plugin`), resolved in
 * the plugin's `onInit`.
 *
 * @since 0.9.0
 */
export type OutboxStoreEntry = IOutboxStore | RegistryFactory<IOutboxStore>;

/**
 * The outbox relay's schedule, budgets and failure policy (M107 §3.6–§3.8).
 *
 * Every numeric option must be a finite integer in its range, and
 * `publishTimeoutMs + storeTimeoutMs` must not exceed `sweepDeadlineMs`;
 * a violation is refused at construction, naming the option.
 *
 * @since 0.9.0
 */
export interface OutboxRelayOptions {
  /**
   * Register the relay on `CAPABILITIES.SCHEDULER` at `onInit`. Set `false` on
   * Cloudflare Workers and call `outbox.sweep()` from a Cron Trigger.
   * Default `true`.
   */
  readonly schedule?: boolean;
  /** Milliseconds between scheduled sweeps. Default `1000`. */
  readonly intervalMs?: number;
  /** Rows read per `scanPending` page. Default `100`. */
  readonly pageSize?: number;
  /** Rows examined per sweep, skips included. Default `1000`. */
  readonly scanLimit?: number;
  /** Publishes and poison transitions per sweep. Default `100`. */
  readonly publishLimit?: number;
  /** Failed keys read at lap start; a full answer caps the lap. Default `1000`. */
  readonly maxFailedScan?: number;
  /** Publish attempts before a row becomes `failed`. Default `10`. */
  readonly maxAttempts?: number;
  /** First retry delay; doubled per attempt. Default `1000`. */
  readonly baseBackoffMs?: number;
  /** Retry delay ceiling. Default `300000`. */
  readonly maxBackoffMs?: number;
  /**
   * One deadline over the whole sweep, measured on the monotonic clock.
   * Default `15000`. Keep it at most `distributedLock.ttlMs - 10000`.
   */
  readonly sweepDeadlineMs?: number;
  /** Bound on one publish. Default `5000`. */
  readonly publishTimeoutMs?: number;
  /** Bound on one store call. Default `5000`. */
  readonly storeTimeoutMs?: number;
}

/**
 * Thresholds for the outbox health indicator (M107 §3.11).
 *
 * @since 0.9.0
 */
export interface OutboxHealthOptions {
  /** The oldest pending row's age that degrades health. Default `60000`. */
  readonly degradedAfterMs?: number;
  /** How long an observed scheduled-sweep overlap degrades health. Default `600000`. */
  readonly overlapWindowMs?: number;
}

/**
 * Options shared by both store forms of {@linkcode OutboxOptions}.
 *
 * @since 0.9.0
 */
export interface OutboxCommonOptions {
  /** Largest serialized envelope `write` accepts, in UTF-8 bytes. Default `262144`. */
  readonly maxEnvelopeBytes?: number;
  /**
   * Receives the promise of a sweep `dispatch()` requests. Default: detached,
   * with a rejection logged. On Cloudflare Workers pass `waitUntil`.
   */
  readonly background?: (promise: Promise<unknown>) => void;
  /** The relay schedule, budgets and failure policy. */
  readonly relay?: OutboxRelayOptions;
  /** Health thresholds. */
  readonly health?: OutboxHealthOptions;
  /**
   * How long `sent` and `discarded` rows are kept. Default 7 days. `0` deletes
   * a row at mark-sent, which also disables overlap detection.
   */
  readonly retainSentMs?: number;
  /** Rows deleted per status per purge run. Default `100`. */
  readonly purgeBatch?: number;
  /** Milliseconds between purge runs. Default `60000`. */
  readonly purgeIntervalMs?: number;
}

/**
 * The outbox option arm: ONE store (column isolation — the tenant, when any,
 * is recorded in the row), or per-tenant `stores` (database per tenant).
 * Supplying both is a compile error.
 *
 * @since 0.9.0
 */
export type OutboxOptions =
  & OutboxCommonOptions
  & (
    | {
      /** The one store every write and the relay use. */
      readonly store: OutboxStoreEntry;
      readonly stores?: never;
    }
    | {
      /** A store per tenant id, selected by the `tenantId` a call names. */
      readonly stores: Readonly<Record<string, OutboxStoreEntry>>;
      readonly store?: never;
    }
  );

/**
 * The optional input of {@linkcode IOutbox.write}.
 *
 * @since 0.9.0
 */
export interface OutboxWriteInput {
  /** Causal metadata, as for `publishIntegrationEvent`. */
  readonly metadata?: IntegrationEventMetadata;
  /**
   * Publish options, resolved with the same precedence as
   * `publishIntegrationEvent`: the caller's `orderingKey` beats the
   * definition's selector, and `deduplicationId` defaults to the envelope id.
   */
  readonly options?: PublishOptions;
  /**
   * The tenant the row belongs to. Recorded in the row with a single store;
   * selects the store (and is required) with per-tenant `stores`.
   */
  readonly tenantId?: string;
}

/**
 * The result of one sweep.
 *
 * @since 0.9.0
 */
export interface OutboxSweepResult {
  /** What requested the sweep. */
  readonly origin: 'scheduled' | 'dispatch';
  /** Rows examined, skips included. */
  readonly scanned: number;
  /** Rows published and marked sent. */
  readonly published: number;
  /** Publish failures recorded. */
  readonly failures: number;
  /** Rows made `failed` (attempts exhausted, or undecodable). */
  readonly poisoned: number;
  /**
   * Why the sweep ended: every store's lap reached its end (`complete`), a
   * budget ran out, a store call rejected (`store-failure`), or the outbox is
   * closing.
   */
  readonly endedBy:
    | 'complete'
    | 'scan-limit'
    | 'publish-limit'
    | 'deadline'
    | 'store-failure'
    | 'closing';
}

/**
 * The transactional outbox, registered under `CAPABILITIES.OUTBOX`
 * (`outbox.<name>` for a named messaging instance).
 *
 * **The promise.** At-least-once delivery of every committed row; per
 * ordering key, publish order among committed rows, provided rows of one key
 * commit in the order they were written and, across replicas, provided the
 * writers' clocks agree; delivery order as the broker gives it. Consumers
 * compare `aggregateVersion`. Never exactly once — a re-send carries the same
 * envelope id as its de-duplication id.
 *
 * @since 0.9.0
 */
export interface IOutbox {
  /**
   * Writes an integration event as an outbox row inside the caller's
   * transaction, through the unit of work the caller's `transaction(...)`
   * handed it. Every refusal is a rejected promise, so the business write
   * rolls back with it.
   *
   * **Caller obligation:** the selected store must read the database `scope`
   * belongs to. A per-tenant store for another tenant, or a store bound to
   * another `database.<name>`, receives a row its relay never sees.
   *
   * @param scope - The caller's unit of work
   * @param definition - The integration-event contract
   * @param payload - The event payload
   * @param input - Metadata, publish options and tenant
   * @returns The envelope id
   */
  write<T>(
    scope: IOutboxWriteScope,
    definition: IntegrationEventDefinition<T>,
    payload: T,
    input?: OutboxWriteInput,
  ): Promise<string>;

  /**
   * Requests a sweep without waiting for it — call it after the transaction
   * resolves. Coalesced: at most one sweep runs and one follow-up waits. Never
   * throws; a no-op once the outbox is closing.
   */
  dispatch(): void;

  /**
   * Runs (or joins) a sweep and resolves with its result.
   *
   * @returns The sweep result
   */
  sweep(): Promise<OutboxSweepResult>;

  /**
   * Deletes `sent` and `discarded` rows older than `retainSentMs`, at most
   * `purgeBatch` per status per store. One deadline, `relay.sweepDeadlineMs`,
   * bounds the whole run across every store; a store call still running at
   * the deadline rejects the purge, and rows already deleted stay deleted.
   *
   * @returns The number of rows deleted
   */
  purge(): Promise<number>;

  /**
   * Releases a `failed` row: `retry` returns it to `pending`; `discard`
   * settles it without publishing. Takes effect for the relay at its next lap.
   * An operator capability: the application gates the route that calls it.
   *
   * @param id - The row (envelope) id
   * @param action - `retry` or `discard`
   * @param options - The tenant, required with per-tenant `stores`
   */
  release(
    id: string,
    action: 'retry' | 'discard',
    options?: { readonly tenantId?: string },
  ): Promise<void>;
}

/**
 * One inbox store: an {@linkcode IInboxStore} instance, or a
 * {@linkcode RegistryFactory} producing one (for example
 * `createDatabaseInboxStore()` from `@setu-ts/database-plugin`), resolved in
 * the plugin's `onInit`.
 *
 * @since 0.9.0
 */
export type InboxStoreEntry = IInboxStore | RegistryFactory<IInboxStore>;

/**
 * The inbox's retention purge schedule (M108 §3.11).
 *
 * @since 0.9.0
 */
export interface InboxPurgeOptions {
  /**
   * Register the purge on `CAPABILITIES.SCHEDULER` at `onInit`. Set `false` on
   * Cloudflare Workers and call `inbox.purge()` from a Cron Trigger. Default
   * `true`.
   */
  readonly schedule?: boolean;
  /** Milliseconds between purge runs. Default `60000`. */
  readonly intervalMs?: number;
  /** Rows deleted per status per purge run, 1–100 000. Default `100`. */
  readonly batch?: number;
}

/**
 * The inbox option arm (M108 §3.11). Every numeric option must be a finite
 * integer in its range; a violation is refused at construction, naming the
 * option.
 *
 * @since 0.9.0
 */
export interface InboxOptions {
  /** The store every inbox subscription records deliveries through. */
  readonly store: InboxStoreEntry;
  /**
   * Park a delivery after this many handler failures (1–1000), acknowledging
   * it so a Kafka partition or a NATS consumer is no longer blocked. Absent
   * (the default), a failure is rethrown and the broker's own retry budget
   * applies — RabbitMQ and Redis Streams retry and dead-letter, while NATS
   * redelivers without limit and Kafka blocks the partition, so set it there.
   */
  readonly maxAttempts?: number;
  /**
   * How long a processed marker is kept, in milliseconds (at least 60 000).
   * A redelivery older than this is processed again, so it must exceed the
   * broker's redelivery window plus the outbox's re-send window. Default 7
   * days. Parked markers are never purged.
   */
  readonly retainMs?: number;
  /**
   * Bound on every store call the inbox makes except the handler's own
   * transaction, in milliseconds. Default `5000`.
   */
  readonly storeTimeoutMs?: number;
  /**
   * Largest envelope, in UTF-8 bytes, stored on a parked marker for
   * `release('retry')`; a larger one is parked without it. `0` stores none.
   * Default `262144`.
   */
  readonly maxParkedEnvelopeBytes?: number;
  /** The retention purge schedule. */
  readonly purge?: InboxPurgeOptions;
}

/**
 * One parked delivery, as {@linkcode IInbox.parked} lists it — never with its
 * envelope.
 *
 * @since 0.9.0
 */
export interface ParkedInboxEntry {
  /** The marker id, for {@linkcode IInbox.release}. */
  readonly rowId: string;
  /** The consumer name. */
  readonly consumer: string;
  /** The subscription topic. */
  readonly topic: string;
  /** The envelope id, when it was stored (a valid publish id). */
  readonly envelopeId?: string;
  /** Handler failures recorded before the delivery was parked. */
  readonly attempts: number;
  /** Epoch milliseconds the delivery was parked. */
  readonly updatedAt: number;
  /** The last handler failure, one bounded line. */
  readonly lastError?: string;
}

/**
 * What {@linkcode IInbox.release} answers.
 *
 * @since 0.9.0
 */
export interface InboxReleaseResult {
  /** The topic the parked delivery arrived on. */
  readonly topic: string;
  /**
   * The parked envelope, parsed, for `retry` — absent for `discard`, and when
   * it was larger than `maxParkedEnvelopeBytes` or unreadable.
   */
  readonly envelope?: unknown;
}

/**
 * The consumer inbox, registered under `CAPABILITIES.INBOX`
 * (`inbox.<name>` for a named messaging instance).
 *
 * **The promise.** For one consumer name, the handler's writes through the
 * supplied unit of work are committed at most once per envelope id while the
 * marker is retained; a delivery after the marker is purged is processed
 * again. Nothing is promised about effects outside that unit of work, about
 * two processes using one consumer name with different handlers, or about a
 * database other than the store's.
 *
 * The delivery path is internal; these are the operator's methods. Each is an
 * operator capability: the application gates any route that calls it.
 *
 * @since 0.9.0
 */
export interface IInbox {
  /**
   * Lists parked deliveries, never their envelopes.
   *
   * @param limit - At most this many, 1–1000. Default `100`
   * @returns The parked deliveries
   */
  parked(limit?: number): Promise<readonly ParkedInboxEntry[]>;

  /**
   * Releases a parked delivery. `retry` deletes the parked marker and answers
   * the stored envelope; re-publish it with `broker.publish(topic, envelope)`
   * — WITHOUT a `deduplicationId`, which NATS and Service Bus would use to
   * drop the re-publish — and the next delivery runs the handler. `discard`
   * keeps the marker as `discarded` with its envelope cleared, so redeliveries
   * stay skipped. The inbox never re-runs a handler itself: that would bypass
   * the messaging behaviour chain.
   *
   * @param rowId - A marker id from {@linkcode IInbox.parked}
   * @param action - `retry` or `discard`
   * @returns The topic, and for `retry` the envelope
   */
  release(rowId: string, action: 'retry' | 'discard'): Promise<InboxReleaseResult>;

  /**
   * Deletes processed and discarded markers and failure-count rows last
   * written before `retainMs` ago, at most `purge.batch` per status.
   *
   * @returns The number of rows deleted
   */
  purge(): Promise<number>;
}
