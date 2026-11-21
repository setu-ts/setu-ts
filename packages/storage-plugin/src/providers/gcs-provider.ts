/**
 * GcsProvider — Google Cloud Storage via lazy `@google-cloud/storage`.
 *
 * Follows the M25 inject-or-lazy pattern: accept an injected
 * {@linkcode IGcsClient} facade, or lazily import and adapt the SDK.
 *
 * @module
 */
import type { PutObjectOptions } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { IGcsClient, StorageProvider } from '../interfaces/index.ts';
import {
  createEagerEventStream,
  looksLikeAsyncIterable,
  looksLikeEventStream,
} from './provider-stream.ts';
import { hasMethods } from './shape.ts';
import type { StorageDeadline, StorageOperation } from './fault.ts';
import { answeredBelow500, resolveRequestTimeout, runBounded, toStorageError } from './fault.ts';

// ── SDK module shapes ─────────────────────────────────────────────────────

/** Shape of the GCS SDK module. */
export interface GcsSdkModule {
  Storage: new (config: Record<string, unknown>) => {
    bucket(name: string): GcsBucket;
  };
}

/** Shape of a GCS bucket handle. */
export interface GcsBucket {
  file(name: string): GcsFile;
  exists(): Promise<[boolean]>;
}

/**
 * Promise-style file shape exposed by the {@linkcode adaptGcsModule} facade
 * (the raw SDK {@linkcode GcsFile} is callback-style; the facade wraps it).
 * This is what {@linkcode GcsProvider} operates against.
 */
export interface GcsFacadeFile {
  getMetadata(): Promise<[Record<string, unknown>]>;
  download(): Promise<{ body: Uint8Array | ArrayLike<number> }>;
  save(data: Uint8Array, options: Record<string, unknown>, cb: (error: Error | null) => void): void;
  delete(): Promise<boolean>;
  getSignedUrl(config: { action: string; expires: number }): Promise<[string]>;
  createReadStream(): NodeJS.ReadableStream;
}

/** Bucket handle exposed by the facade (its `file()` returns a promisified file). */
export interface GcsFacadeBucket {
  file(name: string): GcsFacadeFile;
}

/** Shape of a GCS file handle. */
/**
 * Pinned @google-cloud/storage@7.x is dual-mode: every op supports both a Promise-returning
 * overload (no trailing callback) and a callback-style overload `(err, result) => void`.
 * Evidence from `@google-cloud/storage@7.21.0` type declarations (`file.d.ts`):
 *   - `download(): Promise<DownloadResponse>` / `download(cb)` / `download(opts, cb)`
 *   - `save(data): Promise<void>` / `save(data, cb)` / `save(data, opts, cb)`
 *   - `delete(): Promise<[Response]>` / `delete(opts, cb)` / `delete(cb)`
 *   - `getMetadata(): Promise<MetadataResponse<K>>` / `getMetadata(opts, cb)` / `getMetadata(cb)`
 *   - `getSignedUrl(cfg): Promise<GetSignedUrlResponse>` / `getSignedUrl(cfg, cb)`
 * The callback→Promise bridges below are safe (and the callback-style is what the provider
 * methods use for `put`).
 */
export interface GcsFile {
  getMetadata(): Promise<[Record<string, unknown>]>;
  download(): Promise<{ body: Uint8Array | NodeJS.ReadableStream }>;
  save(
    data: Uint8Array,
    options: Record<string, unknown>,
    callback: (error: Error | null) => void,
  ): void;
  delete(callback: (error: Error | null) => void): void;
  getSignedUrl(config: { action: 'read'; expires: number }): Promise<[string]>;
  createReadStream(): NodeJS.ReadableStream;
}

// ── Options ───────────────────────────────────────────────────────────────

/**
 * Options for {@linkcode GcsProvider}.
 *
 * @since 0.1.0
 */
export interface GcsProviderOptions {
  /** GCP project ID. */
  projectId?: string | undefined;
  /** Bucket name. */
  bucket: string;
  /**
   * API endpoint, such as a private endpoint or an emulator
   * (`http://127.0.0.1:4443`). Passed to the SDK as `apiEndpoint`; the SDK adds
   * `/storage/v1` itself. `STORAGE_EMULATOR_HOST`, when set, overrides it, and credentials
   * follow it: set `endpointAuth: false` with an emulator.
   *
   * @since 0.14.0
   */
  endpoint?: string | undefined;
  /**
   * Whether credentials are sent to a custom `endpoint`. The SDK sends none to
   * a custom endpoint unless told to, so this defaults to `true`; set `false`
   * only for an emulator that checks no credential.
   *
   * @default true
   * @since 0.14.0
   */
  endpointAuth?: boolean | undefined;
  /**
   * Bound on each backend call, in milliseconds. A read that does not settle
   * in time rejects with `BackendUnavailableError` (`503`), a write with
   * `BackendOutcomeUnknownError` (`504`). `0` disables the bound; anything
   * outside `0`–`2147483647` throws `RangeError` at construction.
   *
   * @default 30000
   * @since 0.14.0
   */
  requestTimeoutMs?: number | undefined;
  /** Injected client facade; bypasses the lazy SDK import. */
  client?: IGcsClient | undefined;
}

// ── Validation ────────────────────────────────────────────────────────────

const REQUIRED_GCS_METHODS = ['bucket'] as const;

/**
 * Validates that an injected object matches {@linkcode IGcsClient}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 * @since 0.1.0
 */
export function validateGcsClient(client: unknown): boolean {
  return hasMethods(client, REQUIRED_GCS_METHODS);
}

// ── NotFound detector ─────────────────────────────────────────────────────

/**
 * Reports whether an error is GCS's not-found answer (`code` 404). A message
 * test is not used: a 401 or 403 body can quote "Not Found" too.
 */
export function isGcsNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 404 || code === 'ENOENT';
}

// ── Adapt / Load seams ────────────────────────────────────────────────────

/**
 * Adapts the GCS SDK module to the structural {@linkcode IGcsClient} facade. Pure — unit-tested with a fake
 * module; the real module is supplied on the lazy path by {@linkcode loadGcsModule}.
 *
 * @param mod - The GCS SDK module (real or fake)
 * @param options - GCS connection options
 * @returns The facade wrapping a `Storage` client
 */
export function adaptGcsModule(
  mod: GcsSdkModule,
  options: GcsProviderOptions,
  deadline: StorageDeadline = { timeoutMs: resolveRequestTimeout(options.requestTimeoutMs) },
): IGcsClient {
  const storage = new mod.Storage(buildGcsConfig(options));
  const bucketName = options.bucket;

  return {
    // Readiness: the bucket answered. A refused credential or a missing bucket
    // is an answer (status < 500); a network failure, the bound or a 5xx is not.
    async isHealthy(): Promise<boolean> {
      try {
        await runBounded(deadline, 'gcs', 'probe', () => storage.bucket(bucketName).exists());
        return true;
      } catch (error) {
        return answeredBelow500(error);
      }
    },
    bucket(_name?: string): unknown {
      const b = storage.bucket(_name ?? bucketName);
      return {
        file(name: string) {
          return {
            getMetadata() {
              return new Promise<[Record<string, unknown>]>((resolve, reject) => {
                const fileHandle = b.file(name);
                (
                  fileHandle as {
                    getMetadata: (
                      cb: (err: Error | null, metadata: Record<string, unknown>) => void,
                    ) => void;
                  }
                ).getMetadata((err: Error | null, metadata: Record<string, unknown>) => {
                  if (err) reject(err);
                  else resolve([metadata]);
                });
              });
            },
            download() {
              return new Promise<{ body: Uint8Array | NodeJS.ReadableStream }>(
                (resolve, reject) => {
                  const fileHandle = b.file(name);
                  (
                    fileHandle as {
                      download: (cb: (err: Error | null, data: Uint8Array) => void) => void;
                    }
                  ).download((err: Error | null, data: Uint8Array) => {
                    if (err) reject(err);
                    else resolve({ body: data });
                  });
                },
              );
            },
            save(
              data: Uint8Array,
              options: Record<string, unknown>,
              cb: (error: Error | null) => void,
            ) {
              const fileHandle = b.file(name);
              (
                fileHandle as {
                  save: (
                    data: Uint8Array,
                    options: Record<string, unknown>,
                    cb: (error: Error | null) => void,
                  ) => void;
                }
              ).save(data, options, cb);
            },
            delete() {
              return new Promise<boolean>((resolve, reject) => {
                const fileHandle = b.file(name);
                (fileHandle as { delete: (cb: (err: Error | null) => void) => void }).delete(
                  (err: Error | null) => {
                    if (err) reject(err);
                    else resolve(true);
                  },
                );
              });
            },
            getSignedUrl(config: { action: string; expires: number }) {
              return new Promise<[string]>((resolve, reject) => {
                const fileHandle = b.file(name);
                (
                  fileHandle as {
                    getSignedUrl: (
                      config: { action: string; expires: number },
                      cb: (err: Error | null, url: string) => void,
                    ) => void;
                  }
                ).getSignedUrl(config, (err: Error | null, url: string) => {
                  if (err) reject(err);
                  else resolve([url]);
                });
              });
            },
            createReadStream() {
              return (
                b.file(name) as { createReadStream(): NodeJS.ReadableStream }
              ).createReadStream();
            },
          };
        },
      };
    },
  } as IGcsClient;
}

/**
 * Builds the `Storage` constructor config.
 *
 * `retryOptions.autoRetry` is always `false`: on `@google-cloud/storage` 7.x
 * and 8.x a download whose retried request gets a `502` or `503` ends the
 * process with an unhandled `ERR_STREAM_UNABLE_TO_PIPE` (measured on Node
 * 24.22.1 with 7.22.0 and 8.4.0); with the SDK's retry off the same answer
 * rejects at once. A custom endpoint keeps authentication on unless
 * `endpointAuth` is `false`, because the SDK otherwise sends no credential to
 * it.
 *
 * @param options - GCS connection options
 * @returns The config record
 */
export function buildGcsConfig(options: GcsProviderOptions): Record<string, unknown> {
  const config: Record<string, unknown> = { retryOptions: { autoRetry: false } };
  if (options.projectId !== undefined) config.projectId = options.projectId;
  if (options.endpoint !== undefined) {
    config.apiEndpoint = options.endpoint;
    config.useAuthWithCustomEndpoint = options.endpointAuth ?? true;
  }
  return config;
}

/**
 * Lazily imports the GCS SDK. Only exercised on the lazy path.
 *
 * @returns The SDK module
 * @throws {Error} If the package cannot be resolved
 */
export async function loadGcsModule(): Promise<GcsSdkModule> {
  try {
    return (await import('@google-cloud/storage')) as unknown as GcsSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@google-cloud/storage', {
      requiredBy: '@setu-ts/storage-plugin',
      cause: error,
    });
  }
}

/**
 * Google Cloud Storage provider.
 *
 * Every call runs under `requestTimeoutMs` (the SDK takes no abort signal, so
 * the bound races the call) and every failure other than GCS's not-found
 * answer is classified by `toStorageError`. `getStream` waits for the first
 * chunk before it answers, so an absent object, a refused credential or an
 * outage surfaces before a response is sent; the stream after that is pulled,
 * not drained eagerly.
 *
 * @since 0.1.0
 */
export class GcsProvider implements StorageProvider {
  #client: IGcsClient | null = null;
  readonly #options: GcsProviderOptions;
  readonly #now: (() => number) | undefined;
  readonly #deadline: StorageDeadline;
  /**
   * Delegates to the client's optional `isHealthy?()` — the lazily adapted
   * client's probe calls `bucket.exists()`. Assigned in `connect()` only when
   * the client provides the member; a client that omits it is *unknown*, and
   * the indicator reads absence (not `false`) as that.
   *
   * @since 0.1.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param options - GCS connection/injection options
   * @param now - Wall-clock source (epoch ms) for signed-URL expiry. Injected by
   *   `createProvider` as `runtime.now()` (the only sanctioned clock outside
   *   `packages/runtime`). Without one, `getSignedUrl` rejects by name.
   * @param timing - The runtime timer surface for the bound (ambient timers
   *   when absent)
   * @throws {RangeError} When `requestTimeoutMs` is out of range
   */
  constructor(
    options?: GcsProviderOptions,
    now?: () => number,
    timing?: StorageDeadline['timing'],
  ) {
    this.#options = options ?? { bucket: '' };
    this.#now = now;
    this.#deadline = {
      timeoutMs: resolveRequestTimeout(this.#options.requestTimeoutMs),
      ...(timing !== undefined && { timing }),
    };
  }

  /**
   * Establishes the GCS client — injects the SDK lazily or uses injected client.
   */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateGcsClient(injected)) {
        throw new Error('Injected GCS client is missing required method (bucket)');
      }
      this.#client = injected;
    } else {
      this.#client = adaptGcsModule(await loadGcsModule(), this.#options, this.#deadline);
    }
    this.#installProbe();
  }

  /**
   * Installs `isHealthy` when the client exposes the optional member; leaves it
   * absent (unknown) otherwise.
   */
  #installProbe(): void {
    const client = this.#client;
    if (client !== null && typeof client.isHealthy === 'function') {
      const probe = client.isHealthy;
      this.isHealthy = (): Promise<boolean> => probe.call(client);
    } else {
      delete this.isHealthy;
    }
  }

  /** Disconnect is a no-op for GCS (connectionless HTTP client). */
  disconnect(): Promise<void> {
    this.#client = null;
    delete this.isHealthy;
    return Promise.resolve();
  }

  /** Reports readiness. */
  isReady(): boolean {
    return this.#client !== null;
  }

  #assertConnected(): void {
    if (this.#client === null) {
      throw new Error('GcsProvider is not connected. Call connect() first.');
    }
  }

  #getFile(path: string): GcsFacadeFile {
    // bucket() returns unknown from the facade; narrow through the promisified facade shape.
    return (this.#client!.bucket() as GcsFacadeBucket).file(path);
  }

  /**
   * Runs one call under the bound and classifies its rejection. `notFound`
   * names the value a not-found answer stands for; without it, not-found is a
   * failure like any other.
   */
  async #call<T>(
    operation: StorageOperation,
    run: () => Promise<T>,
    notFound?: { readonly value: T },
  ): Promise<T> {
    this.#assertConnected();
    try {
      return await runBounded(this.#deadline, 'gcs', operation, run);
    } catch (error) {
      if (notFound !== undefined && isGcsNotFound(error)) return notFound.value;
      throw toStorageError(error, 'gcs', operation);
    }
  }

  /**
   * Stores an object in GCS, recording any content type and user metadata on
   * the object itself so a signed URL serves it under the right type.
   *
   * @param path - Object key
   * @param data - Object bytes
   * @param options - Object attributes to record with the bytes
   */
  put(path: string, data: Uint8Array, options?: PutObjectOptions): Promise<void> {
    // `save(data, opts, cb)` is the SDK's three-argument overload; the bag is
    // always passed (empty when the caller supplied nothing) so this package
    // has ONE call shape rather than two that can drift.
    //
    // The nesting is NOT redundant, and reading the shipped types rather than
    // the field name is what showed it: `SaveOptions.metadata` is typed
    // `ConfigMetadata` — the GCS object RESOURCE, whose own `metadata` sub-key
    // holds user key/value pairs. Passing the custom map at the top level would
    // overwrite the resource instead of setting custom metadata on it.
    // `contentType` is different: it is a first-class member of
    // `CreateWriteStreamOptions`, so it stays where the SDK declares it.
    const saveOptions: Record<string, unknown> = {
      ...(options?.contentType === undefined ? {} : { contentType: options.contentType }),
      ...(options?.metadata === undefined ? {} : { metadata: { metadata: options.metadata } }),
    };
    return this.#call(
      'put',
      () =>
        new Promise<void>((resolve, reject) => {
          this.#getFile(path).save(data, saveOptions, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    );
  }

  /**
   * Retrieves an object from GCS; `null` when absent.
   *
   * @param path - Object key
   * @returns The object bytes, or `null`
   */
  get(path: string): Promise<Uint8Array | null> {
    return this.#call<Uint8Array | null>(
      'get',
      async () => {
        const { body } = await this.#getFile(path).download();
        // The facade body is normally a Uint8Array, but a Buffer-like ArrayLike
        // is converted defensively.
        return body instanceof Uint8Array ? body : new Uint8Array(body);
      },
      { value: null },
    );
  }

  /**
   * Deletes an object from GCS: `false` when GCS answers not-found; an outage
   * or a refused credential rejects.
   *
   * @param path - Object key
   * @returns `true` if deleted
   */
  delete(path: string): Promise<boolean> {
    return this.#call(
      'delete',
      async () => {
        await this.#getFile(path).delete();
        return true;
      },
      { value: false },
    );
  }

  /**
   * Reports whether an object exists in GCS: `false` only when GCS answers
   * not-found; an outage or a refused credential rejects.
   *
   * @param path - Object key
   * @returns `true` if present
   */
  exists(path: string): Promise<boolean> {
    return this.#call(
      'exists',
      async () => {
        await this.#getFile(path).getMetadata();
        return true;
      },
      { value: false },
    );
  }

  /**
   * Creates a signed GET URL for a GCS object.
   *
   * @param path - Object key
   * @param options - Expiry in seconds
   * @returns The signed URL
   * @throws {Error} (as a rejection) When the provider has no clock — construct
   *   it with `now`, or register it through `StoragePlugin`
   */
  getSignedUrl(path: string, options: { expiresIn: number }): Promise<string> {
    if (this.#client === null) {
      return Promise.reject(new Error('GcsProvider is not connected. Call connect() first.'));
    }
    const now = this.#now;
    if (now === undefined) {
      return Promise.reject(
        new Error(
          'GcsProvider.getSignedUrl needs a clock: pass now to the constructor, or register ' +
            'the provider through StoragePlugin',
        ),
      );
    }
    return this.#call('getSignedUrl', async () => {
      // The SDK reads a numeric `expires` as epoch MILLISECONDS.
      const expires = now() + options.expiresIn * 1000;
      const [url] = await this.#getFile(path).getSignedUrl({ action: 'read', expires });
      return url;
    });
  }

  /**
   * Native stream download.
   *
   * A real SDK read stream is async-iterable: the provider waits for its first
   * chunk (or its end, or its error) under the bound before answering, so a
   * not-found answer is `null` and a refused credential or an outage rejects,
   * instead of a response that has already begun. The stream it returns pulls
   * the rest on demand and destroys the source when cancelled. A value that is
   * only an event emitter (an injected client) is drained eagerly as before; a
   * value that is neither is refused by name, as a rejection.
   *
   * @param path - Object key
   * @returns A `ReadableStream`, `null` if absent, or a rejection
   */
  // eslint-disable-next-line require-await -- the not-connected refusal and the shape refusal must REJECT, not throw synchronously
  async getStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    this.#assertConnected();
    let readable: unknown;
    try {
      readable = this.#getFile(path).createReadStream();
    } catch (error) {
      if (isGcsNotFound(error)) return null;
      throw toStorageError(error, 'gcs', 'getStream');
    }
    // Shape-checked, never cast: `IGcsClient.bucket()` returns `unknown`, so an
    // injected client's stream is guaranteed nothing by the type system.
    if (looksLikeAsyncIterable(readable)) {
      return this.#peekedStream(readable);
    }
    if (looksLikeEventStream(readable)) {
      return createEagerEventStream(readable);
    }
    throw new Error(
      `GcsProvider: createReadStream() for '${path}' returned a value that is neither ` +
        `async-iterable nor an event emitter, so it cannot be streamed. A real GCS read ` +
        `stream is a node Readable; an injected client must return one, or a value that ` +
        `emits 'data', 'end' and 'error'.`,
    );
  }

  /** Waits for the first chunk, then hands back a pull stream over the rest. */
  async #peekedStream(
    readable: AsyncIterable<unknown>,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const iterator = readable[Symbol.asyncIterator]();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      destroySource(readable);
    };
    let first: IteratorResult<unknown>;
    try {
      first = await runBounded(this.#deadline, 'gcs', 'getStream', () => iterator.next());
    } catch (error) {
      release();
      if (isGcsNotFound(error)) return null;
      throw toStorageError(error, 'gcs', 'getStream');
    }
    return new ReadableStream<Uint8Array>({
      start(controller): void {
        if (first.done === true) controller.close();
        else controller.enqueue(toBytes(first.value));
      },
      async pull(controller): Promise<void> {
        try {
          const next = await iterator.next();
          if (next.done === true) controller.close();
          else controller.enqueue(toBytes(next.value));
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(): Promise<void> {
        release();
        await iterator.return?.();
      },
    });
  }
}

/** Converts a stream chunk to bytes (a node `Buffer` already is one). */
function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  return new Uint8Array(chunk as ArrayLike<number>);
}

/** Destroys a node stream when it exposes `destroy`; a no-op otherwise. */
function destroySource(source: unknown): void {
  const destroy = (source as { destroy?: unknown }).destroy;
  if (typeof destroy === 'function') (destroy as () => void).call(source);
}
