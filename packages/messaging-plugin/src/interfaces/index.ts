/**
 * Internal and option types for the messaging plugin.
 *
 * @module
 */

import type {
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
    command: 'CREATE' | 'DELETE' | 'SETID',
    ...args: string[]
  ): Promise<string | 'OK'>;
  /** Read messages from consumer groups. */
  xreadgroup(...args: string[]): Promise<unknown[][] | null>;
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
 * `CONNECT`, `DISCONNECT`, and `CRASH` (consumer) events. The broker's
 * reconnect supervisor tracks those so `isHealthy` is truthful while the
 * client self-heals.
 *
 * @since 0.1.0
 */
export interface IKafkaEventEmitter {
  /**
   * Registers an event listener.
   *
   * @param event - Event name (`'CONNECT'`, `'DISCONNECT'`, `'CRASH'`, …)
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
   * redeliver and none tracks a delivery count), and runs in declared order
   * ahead of the handler. A behaviour that returns without calling `next()`
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
 * Redis Streams arm.
 *
 * @since 0.1.0
 */
export interface RedisStreamsMessagingOptions extends MessagingCommonOptions {
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
  broker: 'rabbitmq';
  url?: string;
  client?: IAmqpConnection;
  exchangeName?: string;
  defaultQueue?: string;
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
}

/**
 * RabbitMQ-specific options (internal use).
 *
 * @since 0.1.0
 */
export interface RabbitMqOptions {
  /** RabbitMQ connection URL. */
  url?: string;
  /** Injected AMQP connection. */
  client?: IAmqpConnection;
  /** Exchange name (default: 'messaging'). */
  exchangeName?: string;
  /** Default consumer group/queue name. */
  defaultQueue?: string;
  /** Optional logger for error reporting. */
  logger?: { error: (msg: string) => void };
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
   * Topic every request-reply response is published to and read back from.
   *
   * Kafka topics are durable cluster resources and this broker creates none, so
   * the topic must already exist (or `auto.create.topics.enable` must be on).
   * Each broker instance reads it under its own consumer group, so every
   * instance sees every reply and discards those it did not originate — give a
   * high-traffic service its own reply topic to bound that fan-out.
   *
   * @defaultValue `'messaging.replies'`
   */
  replyTopic?: string;
  /** Optional logger for error reporting. */
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
