/**
 * Test doubles for the Cloudflare bindings.
 *
 * Each fake reproduces the behaviour verified from the platform documentation,
 * not a convenient approximation — a fake that accepts any `expirationTtl`
 * would make the store's 60-second floor untestable, and a `delete` that
 * reported what it removed would hide why `R2Storage.delete` heads first.
 */

import type {
  ICacheApi,
  IKvNamespace,
  IQueueMessage,
  IQueueMessageBatch,
  IQueueProducer,
  IR2Bucket,
  IR2Object,
  IR2ObjectBody,
  KvListOptions,
  KvListResult,
  KvPutOptions,
  QueueSendOptions,
} from '../src/index.ts';
import type { ILogger } from '@setu-ts/common';

/** A recorded `put` call, so a test can assert what reached the platform. */
export interface RecordedPut {
  readonly key: string;
  readonly value: string;
  readonly options: KvPutOptions | undefined;
}

/** KV's documented floor, reproduced so a violation fails loudly. */
const KV_MIN_TTL = 60;

/**
 * An in-memory KV namespace.
 *
 * Rejects an `expirationTtl` below 60 exactly as the platform does, and its
 * `delete` resolves whether or not the key existed, reporting nothing.
 */
export class FakeKv implements IKvNamespace {
  readonly entries = new Map<string, string>();
  readonly puts: RecordedPut[] = [];
  readonly deletes: string[] = [];
  /** Page size the fake paginates at, so a test can force a multi-page list. */
  pageSize = 1000;

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  put(key: string, value: string, options?: KvPutOptions): Promise<void> {
    if (options?.expirationTtl !== undefined && options.expirationTtl < KV_MIN_TTL) {
      return Promise.reject(
        new Error(
          `Invalid expiration_ttl of ${options.expirationTtl}. Expiration TTL must be at ` +
            `least ${KV_MIN_TTL}.`,
        ),
      );
    }
    this.entries.set(key, value);
    this.puts.push({ key, value, options });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.entries.delete(key);
    return Promise.resolve();
  }

  /**
   * Pages in key order behind a **key-positioned** cursor, which is what KV's
   * opaque cursor actually encodes.
   *
   * Modelling it as an index into the result set instead would break the
   * standard list-then-delete sweep: deleting page N shrinks the set, so an
   * index cursor would skip the first entries of page N+1. That difference is
   * invisible until a caller deletes while paging — which is exactly what
   * `clear()` does.
   */
  list(options?: KvListOptions): Promise<KvListResult> {
    const prefix = options?.prefix ?? '';
    const after = options?.cursor;
    const remaining = [...this.entries.keys()]
      .filter((k) => k.startsWith(prefix) && (after === undefined || k > after))
      .sort();

    const limit = Math.min(options?.limit ?? this.pageSize, this.pageSize);
    const page = remaining.slice(0, limit);
    const complete = page.length === remaining.length;
    const last = page.at(-1);

    return Promise.resolve({
      keys: page.map((name) => ({ name })),
      list_complete: complete,
      ...(complete || last === undefined ? {} : { cursor: last }),
    });
  }
}

/** A KV namespace whose every method rejects — proves no I/O happens at register(). */
export class ExplodingKv implements IKvNamespace {
  get(): Promise<string | null> {
    return Promise.reject(new Error('KV I/O is not allowed in global scope'));
  }
  put(): Promise<void> {
    return Promise.reject(new Error('KV I/O is not allowed in global scope'));
  }
  delete(): Promise<void> {
    return Promise.reject(new Error('KV I/O is not allowed in global scope'));
  }
  list(): Promise<KvListResult> {
    return Promise.reject(new Error('KV I/O is not allowed in global scope'));
  }
}

/** An in-memory R2 bucket whose `delete` returns void, as the real one does. */
export class FakeR2 implements IR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly deletes: string[] = [];

  head(key: string): Promise<IR2Object | null> {
    const bytes = this.objects.get(key);
    return Promise.resolve(bytes === undefined ? null : meta(key, bytes));
  }

  get(key: string): Promise<IR2ObjectBody | null> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) return Promise.resolve(null);

    return Promise.resolve({
      ...meta(key, bytes),
      body: new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(toArrayBuffer(bytes)),
    });
  }

  put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<IR2Object | null> {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, bytes);
    return Promise.resolve(meta(key, bytes));
  }

  delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }
}

function meta(key: string, bytes: Uint8Array): IR2Object {
  return { key, size: bytes.byteLength, etag: `etag-${bytes.byteLength}` };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** A clock a test advances by hand, so expiry is deterministic. */
export class FakeClock {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}

/** Reads a stream fully, for asserting `getStream` output. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A recorded `send` call, so a test can assert what reached the platform. */
export interface RecordedSend {
  readonly body: unknown;
  readonly options: QueueSendOptions | undefined;
}

/** A Queues producer that records what was sent. */
export class FakeQueueProducer implements IQueueProducer {
  readonly sends: RecordedSend[] = [];
  readonly batches: readonly { readonly body: unknown }[][] = [];

  send(body: unknown, options?: QueueSendOptions): Promise<void> {
    this.sends.push({ body, options });
    return Promise.resolve();
  }

  sendBatch(
    messages: readonly { readonly body: unknown; readonly contentType?: string }[],
  ): Promise<void> {
    (this.batches as { readonly body: unknown }[][]).push([...messages]);
    return Promise.resolve();
  }
}

/**
 * One delivered message.
 *
 * `ack` and `retry` record rather than assert, because the property that
 * matters is that **exactly one** of them fires per message — a fake that threw
 * on the second call would fail the test at the wrong place.
 */
export class FakeQueueMessage implements IQueueMessage {
  acked = 0;
  retried = 0;
  retryOptions: { readonly delaySeconds?: number } | undefined;

  constructor(
    readonly id: string,
    readonly body: unknown,
    readonly attempts: number = 1,
  ) {}

  ack(): void {
    this.acked += 1;
  }

  retry(options?: { readonly delaySeconds?: number }): void {
    this.retried += 1;
    this.retryOptions = options;
  }

  /** How the message was settled, for a single readable assertion. */
  get disposition(): 'acked' | 'retried' | 'unsettled' | 'both' {
    if (this.acked > 0 && this.retried > 0) return 'both';
    if (this.acked > 0) return 'acked';
    if (this.retried > 0) return 'retried';
    return 'unsettled';
  }
}

/**
 * A message whose `ack()` throws, reproducing a platform-side ack failure.
 *
 * Its whole point is to prove `ack()` is not called inside the processor's
 * `try`: there, a throwing ack would be caught as a processor failure and the
 * message would ALSO be retried.
 */
export class AckFailsQueueMessage extends FakeQueueMessage {
  override ack(): void {
    super.ack();
    throw new Error('cannot ack: batch already finalized');
  }
}

/** A delivered batch. */
export class FakeQueueBatch implements IQueueMessageBatch {
  constructor(
    readonly queue: string,
    readonly messages: readonly FakeQueueMessage[],
  ) {}
}

/**
 * The Cache API, recording what was stored.
 *
 * Keys are the request URL string, which is what the middleware passes; a real
 * `Cache` also accepts a `Request`, but the middleware never builds one.
 */
export class FakeCacheApi implements ICacheApi {
  readonly entries = new Map<string, Response>();
  readonly puts: { readonly key: string; readonly response: Response }[] = [];
  readonly matches: string[] = [];

  match(request: Request | string): Promise<Response | undefined> {
    const key = keyOf(request);
    this.matches.push(key);
    const stored = this.entries.get(key);
    // Cloned on read, exactly as the platform hands back a fresh body: returning
    // the same Response twice would give the second reader a used stream.
    return Promise.resolve(stored === undefined ? undefined : stored.clone());
  }

  put(request: Request | string, response: Response): Promise<void> {
    const key = keyOf(request);
    this.entries.set(key, response.clone());
    this.puts.push({ key, response });
    return Promise.resolve();
  }

  delete(request: Request | string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(keyOf(request)));
  }
}

function keyOf(request: Request | string): string {
  return typeof request === 'string' ? request : request.url;
}

/** A logger that records every call, for asserting the reporting paths. */
export class RecordingLogger implements ILogger {
  readonly level = 'debug' as const;
  readonly records: {
    readonly level: string;
    readonly message: string;
    readonly meta?: unknown;
  }[] = [];

  fatal(message: string, metadata?: unknown): void {
    this.#record('fatal', message, metadata);
  }
  error(message: string, metadata?: unknown): void {
    this.#record('error', message, metadata);
  }
  warn(message: string, metadata?: unknown): void {
    this.#record('warn', message, metadata);
  }
  info(message: string, metadata?: unknown): void {
    this.#record('info', message, metadata);
  }
  debug(message: string, metadata?: unknown): void {
    this.#record('debug', message, metadata);
  }
  trace(message: string, metadata?: unknown): void {
    this.#record('trace', message, metadata);
  }
  child(): ILogger {
    return this;
  }

  /** Every message recorded, for a compact assertion. */
  messages(): readonly string[] {
    return this.records.map((record) => record.message);
  }

  #record(level: string, message: string, metadata?: unknown): void {
    this.records.push({ level, message, ...(metadata === undefined ? {} : { meta: metadata }) });
  }
}

/** A deterministic id source, so an assertion can name the id it expects. */
export class SequentialIds {
  #next = 1;

  uuid(): string {
    const id = `id-${this.#next}`;
    this.#next += 1;
    return id;
  }
}
