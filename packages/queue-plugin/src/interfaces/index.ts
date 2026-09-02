/**
 * Queue plugin interfaces and types.
 *
 * @module
 */

import type { Buffer } from 'node:buffer';
import type {
  IIngressBehavior,
  JobProcessor,
  ProcessOptions,
  RegistryFactory,
} from '@setu-ts/common';

/**
 * Structural client type for Redis operations used by RedisQueue.
 *
 * Mirrors the IRedisStreamsClient pattern from messaging-plugin.
 * Intentionally not barrel-exported.
 */
export interface IRedisQueueClient {
  /** Add a member to a sorted set. */
  zadd(key: string, score: number, member: string): Promise<number>;
  /** Get members with scores in a range by score. */
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    ...limitClause: readonly ['LIMIT', number, number] | readonly []
  ): Promise<string[]>;
  /** Remove members from a sorted set. */
  zrem(key: string, ...members: string[]): Promise<number>;
  /** Set a hash field. */
  hset(key: string, field: string, value: string): Promise<number>;
  /** Get a hash field. */
  hget(key: string, field: string): Promise<string | null>;
  /** Delete hash fields. */
  hdel(key: string, ...fields: string[]): Promise<number>;
  /** Delete a key. */
  del(...keys: string[]): Promise<number>;
  /**
   * Number of members in a sorted set. OPTIONAL so an existing injected fake
   * still type-checks; an adapter whose client omits it reports no depths
   * rather than reporting zero.
   *
   * @since 0.3.0
   */
  zcard?(key: string): Promise<number>;
  /**
   * Sets a key's time-to-live in seconds. OPTIONAL for the same reason as
   * {@link zcard}; without it a configured `deadLetterTtlMs` cannot be applied
   * and the retained payload keeps today's unbounded lifetime.
   *
   * @since 0.3.0
   */
  expire?(key: string, seconds: number): Promise<number>;
  /** Connect to Redis (optional). */
  connect?(): Promise<void>;
  /**
   * M70c: resolves when the connection is alive. Optional so a minimal injected
   * fake still type-checks; a client that omits it is *unknown*, not `false`.
   */
  ping?(): Promise<unknown>;
  /** Close the connection. */
  quit(): Promise<void>;
}

/**
 * Structural client type for AMQP connection used by RabbitMqQueue.
 *
 * Mirrors the IRedisQueueClient pattern. Intentionally not barrel-exported.
 */
export interface IAmqpQueueConnection {
  /** Create a channel. */
  createChannel(): Promise<IAmqpQueueChannel>;
  /**
   * M70c: registers a fault listener. The real amqplib connection exposes
   * `'error'`/`'close'`; the adapter sets a fault flag when either fires, which
   * `isHealthy` reads. Optional so a minimal fake still type-checks.
   *
   * @param event - The event name (`'error'` or `'close'`)
   * @param listener - Invoked when the event fires
   * @since 0.1.0
   */
  on?(event: string, listener: (err?: unknown) => void): void;
  /** Close the connection. */
  close(): Promise<void>;
}

/**
 * Structural client type for AMQP channel used by RabbitMqQueue.
 *
 * Intentionally not barrel-exported.
 */
export interface IAmqpQueueChannel {
  /** Assert a queue. */
  assertQueue(queue: string, options?: unknown): Promise<{ queue: string }>;
  /** Publish a message. */
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: unknown,
  ): boolean;
  /** Get a message (polling). */
  get(queue: string, options?: unknown): Promise<IAmqpQueueMessage | false>;
  /** Acknowledge a message. */
  ack(message: unknown): void;
  /** Close the channel. */
  close(): Promise<void>;
}

/**
 * Structural type for an AMQP message returned by get().
 *
 * Intentionally not barrel-exported.
 */
export interface IAmqpQueueMessage {
  /** The message content (Buffer). */
  content: Buffer;
  /** Message fields. */
  fields: unknown;
  /** Message properties. */
  properties: unknown;
}

/**
 * A job stored in the queue adapter.
 *
 * Intentionally not barrel-exported.
 */
export interface StoredJob<T = unknown> {
  /** Job ID. */
  id: string;
  /** Job name. */
  name: string;
  /** Job payload. */
  data: T;
  /** Current attempt count. */
  attempts: number;
  /** Maximum attempts allowed. */
  maxAttempts: number;
  /** Timestamp when the job becomes available (ms since epoch). */
  availableAtMs: number;
  /**
   * Opaque token identifying THIS delivery, set by `reserve` on adapters whose
   * transport hands out a per-delivery claim (SQS populates it from the receipt
   * handle). `runJob` passes it back on `ack`/`requeue`/`deadLetter` so the
   * adapter can reject a settle belonging to a superseded delivery.
   *
   * Adapters with no transport-level claim (memory, redis, rabbitmq) leave it
   * unset and ignore the argument; `runJob` then falls back to {@link id}.
   */
  claimToken?: string;
}

/**
 * A recurring job stored in the queue adapter.
 *
 * Intentionally not barrel-exported.
 */
export interface StoredRecurring {
  /** Recurring job ID. */
  id: string;
  /** Job name. */
  name: string;
  /** Job payload. */
  data: unknown;
  /** Cron expression. */
  cron: string;
  /** Next run timestamp (ms since epoch). */
  nextRunAtMs: number;
}

/**
 * Queue adapter type for plugin configuration.
 */
export type QueueAdapterType = 'memory' | 'redis' | 'rabbitmq' | 'sqs';

/**
 * Options for configuring the queue plugin.
 */
export interface QueuePluginOptions {
  /** The adapter type to use (default 'memory'). */
  adapter?: QueueAdapterType;
  /** Instance name for multi-instance support. */
  name?: string;
  /** Connection URL (used when adapter is 'redis' or 'rabbitmq'). */
  url?: string;
  /** Injected client (bypasses lazy import). */
  client?: IRedisQueueClient | IAmqpQueueConnection;
  /** Default max attempts for jobs (default 3). */
  defaultMaxAttempts?: number;
  /** Poll interval for worker loop (default 1000ms). */
  pollIntervalMs?: number;
  /** Queue name prefix for RabbitMQ adapter (default 'he.queue'). */
  prefix?: string;
  /**
   * How long a dead-lettered job's payload is retained, in milliseconds.
   *
   * Omitted (the default) keeps today's behaviour: the payload is retained
   * indefinitely "for debugging", so the jobs hash grows without bound for the
   * lifetime of the deployment (X8-4). Applied only by the Redis adapter, and
   * only when the injected client exposes `expire`.
   *
   * Enforced PER PAYLOAD: each dead-letter sweeps the dead set — scored by
   * dead-letter time — and deletes every entry older than this, so a queue that
   * keeps failing still drops its oldest payloads. Setting it also relocates a
   * dead job's payload from `queue:<name>:jobs`, which holds every queued job's
   * payload for that name, into `queue:<name>:dead:jobs`.
   *
   * The retention it delivers is a bound rather than a deadline: AT LEAST this
   * long, and AT MOST this long past the LAST dead-letter on the queue — so a
   * payload that dies just before a short burst can live for just under twice
   * this value. The sweep runs only when a dead-letter arrives, and the
   * key-level backstop beside it carries one deadline for a shared key, which
   * must be the newest or it would take newer payloads with it. It errs late
   * deliberately: dropping a payload early discards the debugging data this
   * option exists to keep.
   *
   * @since 0.3.0
   */
  deadLetterTtlMs?: number;
  /** SQS-specific options (required when adapter is 'sqs'). */
  sqs?: import('../adapters/sqs-queue.ts').SqsQueueOptions;
  /**
   * Processors registered declaratively, as an alternative to calling
   * `queue.process(name, processor, options)` imperatively after `start()`.
   * Each entry — instance or `RegistryFactory` — produces one `process()`
   * call, so a processor can be declared where the plugin is composed instead
   * of after the application has started.
   *
   * Instance entries register during the plugin's `register()` phase,
   * identical to the imperative timing. Factory entries are resolved in the
   * `onInit` phase — the first at which the registry holds every capability —
   * so a factory can build its processor from a resolved capability. A
   * factory that throws rejects `start()` with an error naming
   * `QueuePlugin({ processors })` and the entry's index in THIS declared
   * array, not its position among the factories.
   *
   * Registering two entries under one job name keeps the service's existing
   * last-wins behaviour: exactly what two imperative `process()` calls with
   * the same name do.
   *
   * @since 0.3.0
   */
  readonly processors?: readonly QueueProcessorEntry[];
  /**
   * Ingress behaviours wrapped around every processor — the queue arm of the
   * transport-neutral behaviour chain shared with the websocket, scheduler,
   * and messaging plugins (`IIngressBehavior` in `@setu-ts/common`).
   *
   * Each behaviour observes an `IngressContext` carrying `kind: 'queue'`, the
   * job name as `name`, the delivered `IJob` as `payload`, and `attempt`
   * equal to `IJob.attempts`, and runs in declared order ahead of the
   * processor. A behaviour that returns without calling `next()`
   * short-circuits: the processor never sees the job and the job is
   * acknowledged. A behaviour that throws follows the processor's own failure
   * path — requeue with backoff, and `ProcessOptions.onFailed` plus the
   * dead-letter on the final attempt. Every processor registration is
   * wrapped, imperative `process()` calls included, so a mixed application
   * cannot leave a handler unchained.
   *
   * With no behaviours configured, dispatch is byte-identical to the
   * pre-chain behaviour: the processor is handed the job directly, with no
   * chain allocated.
   *
   * Instance entries are handed to the service at `register()`; factory
   * entries are resolved in the `onInit` phase and a throwing factory rejects
   * `start()` naming `QueuePlugin({ behaviors })` and the entry's index in
   * THIS declared array.
   *
   * @since 0.3.0
   */
  readonly behaviors?: readonly (IIngressBehavior | RegistryFactory<IIngressBehavior>)[];
}

/**
 * The declarative form of one `IQueue.process()` call — the entry an
 * application writes instead of calling `process()` imperatively after
 * `start()`.
 *
 * @since 0.3.0
 */
export interface QueueProcessorDefinition {
  /** The job name this processor handles (the `process()` name argument). */
  readonly name: string;
  /** Invoked per delivered job, exactly as the imperative `process()` accepts. */
  readonly processor: JobProcessor;
  /** Per-name configuration, exactly as the imperative `process()` accepts. */
  readonly options?: ProcessOptions;
}

/**
 * One entry of {@linkcode QueuePluginOptions.processors}: a processor
 * definition, or a {@linkcode RegistryFactory} producing one when the
 * processor needs a resolved capability.
 *
 * @since 0.3.0
 */
export type QueueProcessorEntry =
  | QueueProcessorDefinition
  | RegistryFactory<QueueProcessorDefinition>;

/**
 * Options for configuring RedisQueue.
 */
export interface RedisQueueOptions {
  /** Redis connection URL (default 'redis://localhost:6379'). */
  url?: string;
  /** Injected Redis client (bypasses lazy import). */
  client?: IRedisQueueClient;
  /**
   * How long a dead-lettered job's payload is retained, in milliseconds; see
   * {@link QueuePluginOptions.deadLetterTtlMs}.
   *
   * @since 0.3.0
   */
  deadLetterTtlMs?: number;
}

/**
 * Options for configuring RabbitMqQueue.
 */
export interface RabbitMqQueueOptions {
  /** RabbitMQ connection URL (default 'amqp://localhost:5672'). */
  url?: string;
  /** Injected AMQP connection (bypasses lazy import). */
  client?: IAmqpQueueConnection;
  /** Queue name prefix (default 'he.queue'). */
  prefix?: string;
}
