/**
 * Structural facades for the Cloudflare Workers bindings this package touches.
 *
 * These are hand-written rather than imported from `@cloudflare/workers-types`,
 * following the M25/M29/M50 precedent: a structural interface keeps the
 * published dependency graph empty, keeps the package type-checkable on Deno,
 * Node, and Bun, and makes a test fake trivial to construct. A real
 * `KVNamespace`/`R2Bucket`/`D1Database` satisfies the matching interface
 * structurally, so no cast is needed at the application boundary.
 *
 * Each facade covers only the members this package (and its documented escape
 * hatches) actually call — interface segregation, AI_GUIDELINES §1.1.
 *
 * @module
 */

/**
 * A Workers KV namespace binding.
 *
 * @since 0.2.0
 */
export interface IKvNamespace {
  /**
   * Reads a value as text.
   *
   * @param key - The key, at most 512 bytes
   * @returns The stored string, or `null` when absent or expired
   */
  get(key: string): Promise<string | null>;
  /**
   * Writes a value.
   *
   * @param key - The key, at most 512 bytes
   * @param value - The value, at most 25 MiB
   * @param options - `expirationTtl` is in seconds and has a platform minimum
   * of 60; a smaller value is rejected by KV
   */
  put(key: string, value: string, options?: KvPutOptions): Promise<void>;
  /**
   * Removes a value. Succeeds whether or not the key existed.
   *
   * @param key - The key to remove
   */
  delete(key: string): Promise<void>;
  /**
   * Lists keys, one page at a time.
   *
   * @param options - Prefix filter, page size (1000 maximum), and cursor
   * @returns One page of keys plus the pagination state
   */
  list(options?: KvListOptions): Promise<KvListResult>;
}

/**
 * Options for {@linkcode IKvNamespace.put}.
 *
 * @since 0.2.0
 */
export interface KvPutOptions {
  /**
   * Seconds until KV removes the entry. The platform minimum is **60**; a
   * smaller value is rejected, which is why {@linkcode physicalTtlSeconds}
   * floors it and a logical expiry is carried inside the value.
   */
  readonly expirationTtl?: number;
}

/**
 * Options for {@linkcode IKvNamespace.list}.
 *
 * @since 0.2.0
 */
export interface KvListOptions {
  /** Return only keys starting with this prefix. */
  readonly prefix?: string;
  /** Page size. The platform default and maximum are both 1000. */
  readonly limit?: number;
  /** Continuation cursor from a previous page. */
  readonly cursor?: string;
}

/**
 * One page of {@linkcode IKvNamespace.list} results.
 *
 * @since 0.2.0
 */
export interface KvListResult {
  /** The keys in this page. */
  readonly keys: readonly { readonly name: string }[];
  /** `true` when this page is the last one. */
  readonly list_complete: boolean;
  /** Cursor for the next page; absent on the last page. */
  readonly cursor?: string;
}

/**
 * Metadata common to every R2 object.
 *
 * @since 0.2.0
 */
export interface IR2Object {
  /** The object key. */
  readonly key: string;
  /** Object size in bytes. */
  readonly size: number;
  /** The object's entity tag. */
  readonly etag: string;
}

/**
 * An R2 object together with its body.
 *
 * @since 0.2.0
 */
export interface IR2ObjectBody extends IR2Object {
  /** The object body as a stream — the zero-copy download path. */
  readonly body: ReadableStream<Uint8Array>;
  /**
   * Reads the whole body into memory.
   *
   * @returns The object bytes
   */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * An R2 bucket binding.
 *
 * @since 0.2.0
 */
export interface IR2Bucket {
  /**
   * Reads object metadata without transferring the body.
   *
   * @param key - The object key
   * @returns The metadata, or `null` when the object does not exist
   */
  head(key: string): Promise<IR2Object | null>;
  /**
   * Reads an object.
   *
   * @param key - The object key
   * @returns The object with its body, or `null` when it does not exist
   */
  get(key: string): Promise<IR2ObjectBody | null>;
  /**
   * Writes an object.
   *
   * @param key - The object key
   * @param value - The object bytes
   * @returns The stored object's metadata
   */
  put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<IR2Object | null>;
  /**
   * Removes an object. Succeeds whether or not it existed, and reports nothing
   * about what was removed — which is why {@linkcode R2Storage.delete} heads
   * first to honor its committed `Promise<boolean>`.
   *
   * @param key - The object key
   */
  delete(key: string): Promise<void>;
}

/**
 * A prepared D1 statement.
 *
 * @since 0.2.0
 */
export interface ID1PreparedStatement {
  /**
   * Binds ordered parameters. D1 supports `?` and `?NNN`, not named parameters.
   *
   * @param values - Parameter values, in order
   * @returns The bound statement
   */
  bind(...values: readonly unknown[]): ID1PreparedStatement;
  /**
   * Runs the statement and returns every row.
   *
   * @typeParam T - The row shape
   * @returns The rows plus D1's result metadata
   */
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  /**
   * Runs the statement and returns the first row.
   *
   * @typeParam T - The row shape
   * @returns The first row, or `null` when there are none
   */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  /**
   * Runs the statement for its effect.
   *
   * @typeParam T - The row shape
   * @returns D1's result metadata
   */
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

/**
 * A D1 statement result.
 *
 * @typeParam T - The row shape
 * @since 0.2.0
 */
export interface D1Result<T = Record<string, unknown>> {
  /** The returned rows; empty for a write. */
  readonly results: readonly T[];
  /** Whether the statement succeeded. */
  readonly success: boolean;
}

/**
 * A D1 database binding.
 *
 * Exposed as an escape hatch for applications that want SQL today. A first-class
 * `IDatabase` backend is M52c, because the seam a backend implements
 * (`IDatabaseAdapter`) lives inside `database-plugin` and is not a committed
 * `common` port.
 *
 * @since 0.2.0
 */
export interface ID1Database {
  /**
   * Prepares a statement.
   *
   * @param query - The SQL text
   * @returns The prepared statement
   */
  prepare(query: string): ID1PreparedStatement;
  /**
   * Runs several statements as one atomic transaction. D1 exposes no
   * imperative `BEGIN`/`COMMIT`, so this is its unit of atomicity.
   *
   * @typeParam T - The row shape
   * @param statements - The statements to run together
   * @returns One result per statement, in order
   */
  batch<T = Record<string, unknown>>(
    statements: readonly ID1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]>;
}

/**
 * Options for {@linkcode IQueueProducer.send}.
 *
 * @since 0.2.0
 */
export interface QueueSendOptions {
  /** How the body is serialized. Defaults to `'json'`. */
  readonly contentType?: 'json' | 'text' | 'bytes' | 'v8';
  /** Delivery delay in seconds, from 0 to 86400. */
  readonly delaySeconds?: number;
}

/**
 * A Cloudflare Queues **producer** binding.
 *
 * The consumer half is {@linkcode IQueueMessageBatch}, dispatched by the
 * handler `createQueueHandler` builds for the Worker's `queue` export.
 *
 * @since 0.2.0
 */
export interface IQueueProducer {
  /**
   * Enqueues one message, at most 128 KB.
   *
   * @param body - The message body
   * @param options - Serialization and delay
   */
  send(body: unknown, options?: QueueSendOptions): Promise<void>;
  /**
   * Enqueues up to 100 messages, at most 256 KB in total.
   *
   * @param messages - The message bodies, each optionally with its own options
   */
  sendBatch(
    messages: readonly { readonly body: unknown; readonly contentType?: string }[],
  ): Promise<void>;
}

/**
 * One message delivered to a Queues **consumer**.
 *
 * A real Cloudflare `Message` satisfies this structurally. `ack()` and
 * `retry()` are the platform's only two dispositions: there is no "dead-letter
 * now" call, because that policy lives in the queue's `wrangler.toml` stanza.
 *
 * @since 0.2.0
 */
export interface IQueueMessage {
  /** The platform-assigned message id. */
  readonly id: string;
  /** The message body, as the producer sent it. */
  readonly body: unknown;
  /** Delivery attempt, **1 on first delivery** — the same base as `IJob`. */
  readonly attempts: number;
  /** Marks the message processed. It is not redelivered. */
  ack(): void;
  /**
   * Returns the message for redelivery, subject to the queue's configured
   * `max_retries` and dead-letter queue.
   *
   * @param options - Optional redelivery delay
   */
  retry(options?: { readonly delaySeconds?: number }): void;
}

/**
 * A batch of messages delivered to a Queues consumer.
 *
 * A real Cloudflare `MessageBatch` satisfies this structurally.
 *
 * @since 0.2.0
 */
export interface IQueueMessageBatch {
  /** The name of the queue this batch came from. */
  readonly queue: string;
  /** The messages in the batch. */
  readonly messages: readonly IQueueMessage[];
}

/**
 * The controller handed to a Cron Trigger's `scheduled` handler.
 *
 * A real Cloudflare `ScheduledController` satisfies this structurally.
 *
 * @since 0.2.0
 */
export interface IScheduledController {
  /**
   * The cron expression that fired, **exactly as written in `wrangler.toml`**.
   *
   * This is the only key a dispatcher can match on: the platform reports which
   * of the Worker's configured triggers fired, not a name of our choosing.
   */
  readonly cron: string;
  /** When the trigger was scheduled to fire, in epoch milliseconds. */
  readonly scheduledTime: number;
}

/**
 * A service binding to another Worker — a `fetch`-shaped RPC channel.
 *
 * @since 0.2.0
 */
export interface IServiceBinding {
  /**
   * Invokes the bound Worker.
   *
   * @param input - The request, as `fetch` accepts it
   * @param init - Request initialization
   * @returns The bound Worker's response
   */
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

/**
 * A Durable Object namespace binding.
 *
 * Exposed as an escape hatch. A DO-backed realtime backplane and distributed
 * lock are M52d, because both need the application to export a DO class.
 *
 * @since 0.2.0
 */
export interface IDurableObjectNamespace {
  /**
   * Derives a stable object id from a name.
   *
   * @param name - The logical object name
   * @returns The object id
   */
  idFromName(name: string): unknown;
  /**
   * Returns a stub for the object with this id.
   *
   * @param id - An id from {@linkcode idFromName}
   * @returns A `fetch`-shaped stub
   */
  get(id: unknown): IServiceBinding;
}

/**
 * The Worker `env` record, as `import { env } from 'cloudflare:workers'`
 * provides it: a mix of string variables and object bindings.
 *
 * @since 0.2.0
 */
export type CloudflareWorkerEnv = Readonly<Record<string, unknown>>;

/** Reports whether every named member of `value` is a function. */
function hasMethods(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return methods.every((method) => typeof record[method] === 'function');
}

/**
 * Reports whether a binding is KV-shaped.
 *
 * Used to fail at `register()` with a name rather than at the first request
 * with a bare `TypeError`, when a configured binding turns out to be something
 * else (a mistyped name pointing at an R2 bucket, for instance).
 *
 * @param value - The binding to check
 * @returns `true` when it carries the KV methods
 * @since 0.2.0
 */
export function isKvNamespace(value: unknown): value is IKvNamespace {
  return hasMethods(value, ['get', 'put', 'delete', 'list']);
}

/**
 * Reports whether a binding is R2-shaped.
 *
 * @param value - The binding to check
 * @returns `true` when it carries the R2 bucket methods
 * @since 0.2.0
 */
export function isR2Bucket(value: unknown): value is IR2Bucket {
  return hasMethods(value, ['head', 'get', 'put', 'delete']);
}
