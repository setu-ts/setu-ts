/**
 * Test doubles for the Cloudflare bindings.
 *
 * Each fake reproduces the behaviour verified from the platform documentation,
 * not a convenient approximation — a fake that accepts any `expirationTtl`
 * would make the store's 60-second floor untestable, and a `delete` that
 * reported what it removed would hide why `R2Storage.delete` heads first.
 */

import type {
  IKvNamespace,
  IR2Bucket,
  IR2Object,
  IR2ObjectBody,
  KvListOptions,
  KvListResult,
  KvPutOptions,
} from '../src/index.ts';

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
