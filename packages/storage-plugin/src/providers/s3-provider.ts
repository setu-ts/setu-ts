/**
 * S3Provider — AWS S3 object storage via lazy `@aws-sdk/client-s3` +
 * `@aws-sdk/s3-request-presigner`.
 *
 * Follows the M25 inject-or-lazy pattern with one caveat worth stating
 * plainly: the injectable {@linkcode IS3Backend} is the surface
 * {@linkcode adaptAwsS3Module} PRODUCES, not the SDK's own, so injecting it
 * means implementing the backend rather than supplying a configured
 * `S3Client` (X8-10).
 *
 * @module
 */
import type { PutObjectOptions } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { IS3Backend, StorageProvider } from '../interfaces/index.ts';
import type { StorageDeadline, StorageOperation } from './fault.ts';
import {
  answeredStatus,
  destroyOnAbort,
  resolveRequestTimeout,
  runBounded,
  toStorageError,
} from './fault.ts';
import { createBoundedNodeStream, looksLikeNodeReadable } from './provider-stream.ts';
import { hasMethods } from './shape.ts';
import { storageKeyRefusal } from '../services/storage-key.ts';

// ── SDK module shapes ─────────────────────────────────────────────────────

/** Shape of the S3 SDK client module. */
export interface AwsSdkModule {
  S3Client: new (config: Record<string, unknown>) => {
    send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  };
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
  HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
}

/** Shape of the presigner SDK module. */
export interface PresignerSdkModule {
  getSignedUrl(
    client: unknown,
    command: unknown,
    options?: Record<string, unknown>,
  ): Promise<string>;
}

/** Combined S3 SDK module shape. */
export interface AwsStorageSdkModule {
  s3: AwsSdkModule;
  presigner: PresignerSdkModule;
}

// ── Options ───────────────────────────────────────────────────────────────

/**
 * Options for {@linkcode S3Provider}.
 *
 * @since 0.1.0
 */
export interface S3ProviderOptions {
  /** AWS region for the lazily-loaded client. */
  region?: string | undefined;
  /** Bucket name. */
  bucket: string;
  /** AWS access key id for the lazily-loaded client. */
  accessKeyId?: string | undefined;
  /** AWS secret access key for the lazily-loaded client. */
  secretAccessKey?: string | undefined;
  /** Custom endpoint (R2, MinIO, B2). */
  endpoint?: string | undefined;
  /**
   * Bound on each backend call, in milliseconds, including the SDK's own
   * retries. A read that does not settle in time rejects with
   * `BackendUnavailableError` (`503`), a write with `BackendOutcomeUnknownError`
   * (`504`). `0` disables the bound; anything outside `0`–`2147483647` throws
   * `RangeError` at construction.
   *
   * @default 30000
   * @since 0.14.0
   */
  requestTimeoutMs?: number | undefined;
  /** Injected client facade; bypasses the lazy SDK import. */
  client?: IS3Backend | undefined;
}

// ── Validation ────────────────────────────────────────────────────────────

const REQUIRED_S3_METHODS = ['put', 'get', 'delete', 'head', 'getSignedUrl', 'getStream'] as const;

/**
 * Validates that an injected object matches {@linkcode IS3Backend}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 * @since 0.1.0
 */
export function validateAwsS3Client(client: unknown): boolean {
  return hasMethods(client, REQUIRED_S3_METHODS);
}

// ── NotFound detector ─────────────────────────────────────────────────────

/** Reports whether an error indicates a missing S3 object. */
function isS3NotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const n = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  // A 404 the SDK parsed into another S3 code (`NoSuchBucket`) is not a miss;
  // one with no S3 code (an unnamed or plain `Error`) is.
  return (
    n === 'NoSuchKey' || n === 'NotFound' || (status === 404 && (n === undefined || n === 'Error'))
  );
}

// ── Adapt / Load seams ────────────────────────────────────────────────────

/**
 * Builds an S3 client config without assigning `undefined` to optional fields.
 *
 * When a custom `endpoint` is configured (R2, MinIO, B2, LocalStack, …) the config also sets
 * `forcePathStyle: true`: S3-compatible gateways do not support virtual-hosted-style
 * addressing (`<bucket>.<endpoint>`) against a custom host, so the SDK must address the
 * bucket as a path segment (`<endpoint>/<bucket>/<key>`) instead.
 *
 * @param options - S3 connection options
 * @returns The config record for the lazily-loaded `S3Client`
 */
function buildS3Config(options: S3ProviderOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (options.region !== undefined) config.region = options.region;
  if (options.accessKeyId !== undefined && options.secretAccessKey !== undefined) {
    config.credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    };
  }
  if (options.endpoint !== undefined) {
    config.endpoint = options.endpoint;
    // Custom endpoints (MinIO, R2, B2, LocalStack) reject virtual-hosted-style
    // addressing; force `<endpoint>/<bucket>/<key>` path-style requests.
    config.forcePathStyle = true;
  }
  return config;
}

/**
 * Adapts the AWS SDK module to the structural {@linkcode IS3Backend} facade. Pure — unit-tested with a fake
 * module; the real module is supplied on the lazy path by {@linkcode loadAwsS3Module}.
 *
 * @param mod - The combined SDK module (real or fake)
 * @param options - S3 connection options
 * @returns The facade wrapping an `S3Client`
 */
export function adaptAwsS3Module(
  mod: AwsStorageSdkModule,
  options: S3ProviderOptions,
  deadline: StorageDeadline = { timeoutMs: resolveRequestTimeout(options.requestTimeoutMs) },
  provider = 's3',
): IS3Backend {
  const bucket = options.bucket;
  const s3Mod = mod.s3;
  const presignerMod = mod.presigner;
  const client = new s3Mod.S3Client(buildS3Config(options));
  // Every SDK call runs under the bound and receives its signal, so an expired
  // bound also aborts the request the SDK is holding. A caller that owns the
  // bound (`S3Provider`) passes its own signal instead.
  const bounded = <T>(
    operation: StorageOperation,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    signal === undefined ? runBounded(deadline, provider, operation, run) : run(signal);
  const send = (
    operation: StorageOperation,
    command: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    bounded(operation, signal, (abortSignal) => client.send(command, { abortSignal }));

  return {
    async put(
      path: string,
      data: Uint8Array,
      options?: PutObjectOptions,
      signal?: AbortSignal,
    ): Promise<void> {
      // `ContentType`/`Metadata` are omitted rather than sent as `undefined`:
      // the SDK serializes a present-but-undefined key differently from an
      // absent one on some commands, and an object stored with no explicit
      // content type keeps S3's own default.
      await send(
        'put',
        new s3Mod.PutObjectCommand({
          Bucket: bucket,
          Key: path,
          Body: data,
          ...(options?.contentType === undefined ? {} : { ContentType: options.contentType }),
          ...(options?.metadata === undefined ? {} : { Metadata: options.metadata }),
        }),
        signal,
      );
    },
    get(path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
      // The body is read under the same bound as the request, and destroyed
      // when the bound expires, so a stalled body releases its connection.
      return bounded('get', signal, async (abortSignal) => {
        try {
          const res = (await client.send(
            new s3Mod.GetObjectCommand({ Bucket: bucket, Key: path }),
            { abortSignal },
          )) as { Body?: unknown };
          const body = res.Body;
          destroyOnAbort(body, abortSignal);
          // Real SDK v3 Body is an SdkStreamMixin with transformToByteArray().
          if (hasMethods(body, ['transformToByteArray'])) {
            return (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
          }
          // Fallback: already a Uint8Array or translatable.
          return body instanceof Uint8Array ? body : new Uint8Array(body as ArrayLike<number>);
        } catch (error) {
          if (isS3NotFound(error)) return null;
          throw error;
        }
      });
    },
    // S3's DeleteObject answers 204 whether or not the key existed; `S3Provider`
    // checks presence with `head` first so an absent key answers `false`.
    async delete(path: string, signal?: AbortSignal): Promise<boolean> {
      await send('delete', new s3Mod.DeleteObjectCommand({ Bucket: bucket, Key: path }), signal);
      return true;
    },
    // `false` only for a definite not-found answer; an outage or a refused
    // credential rejects, so a caller never reads it as "not there".
    async head(path: string, signal?: AbortSignal): Promise<boolean> {
      try {
        await send('exists', new s3Mod.HeadObjectCommand({ Bucket: bucket, Key: path }), signal);
        return true;
      } catch (error) {
        if (isS3NotFound(error)) return false;
        throw error;
      }
    },
    getSignedUrl(path: string, expiresIn: number): Promise<string> {
      // Build a real presigned URL via the presigner (a local signature: the
      // bound covers the credential resolution it may perform).
      return runBounded(deadline, provider, 'getSignedUrl', () =>
        presignerMod.getSignedUrl(
          client,
          new s3Mod.GetObjectCommand({ Bucket: bucket, Key: path }),
          { expiresIn },
        ),
      );
    },
    async getStream(
      path: string,
      signal?: AbortSignal,
    ): Promise<ReadableStream<Uint8Array> | null> {
      try {
        const res = (await send(
          'getStream',
          new s3Mod.GetObjectCommand({ Bucket: bucket, Key: path }),
          signal,
        )) as { Body?: unknown };
        const body = res.Body;
        // Real SDK v3 Body is an SdkStreamMixin with transformToWebStream().
        if (hasMethods(body, ['transformToWebStream'])) {
          // When the body is the SDK's node stream (Deno/Node/Bun), wrap it
          // ourselves: the adapter stream `transformToWebStream()` produces
          // crashes the PROCESS when a consumer cancels while the origin
          // connection tears down — a late `'data'` emission lands in the
          // closed controller (`onData` → enqueue) as an uncaught TypeError
          // (upstream ext:deno_node adapter defect, live on Deno 2.9.6).
          // createBoundedNodeStream drives the node stream in paused mode,
          // destroys it on cancel, and keeps the measured ~3.2 MiB
          // read-ahead this suite pins (stream-backpressure-real.test.ts).
          // Non-node-shaped bodies (injected fakes) keep the historical path.
          if (looksLikeNodeReadable(body)) {
            return createBoundedNodeStream(body);
          }
          return (
            body as { transformToWebStream(): ReadableStream<Uint8Array> }
          ).transformToWebStream();
        }
        // Fallback: Body is already a Web ReadableStream (injected fake).
        if (hasMethods(body, ['getReader'])) {
          return body as ReadableStream<Uint8Array>;
        }
        // Fake path: wrap raw bytes in a one-chunk stream.
        if (body instanceof Uint8Array) {
          return new ReadableStream({
            start(controller) {
              controller.enqueue(body);
              controller.close();
            },
          });
        }
        return null;
      } catch (error) {
        if (isS3NotFound(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * Lazily imports the AWS S3 + presigner SDK. Only exercised on the lazy path.
 *
 * Two guards, one per import, so the error names the package that actually
 * failed rather than sniffing a rejection message (M113d §3.1). The imports are
 * direct statements in their own `try` blocks, not nested in a `Promise.all` —
 * a bundler that resolves dynamic imports at build time (esbuild inside
 * Wrangler) leaves a same-function `try`-guarded import as a runtime import but
 * refuses one nested in a call's arguments.
 *
 * @returns The combined SDK module
 * @throws {Error} If the packages cannot be resolved
 */
export async function loadAwsS3Module(): Promise<AwsStorageSdkModule> {
  let s3Mod: AwsSdkModule;
  try {
    s3Mod = (await import('@aws-sdk/client-s3')) as unknown as AwsSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@aws-sdk/client-s3', {
      requiredBy: '@setu-ts/storage-plugin',
      cause: error,
    });
  }
  let presignerMod: PresignerSdkModule;
  try {
    presignerMod = (await import('@aws-sdk/s3-request-presigner')) as PresignerSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@aws-sdk/s3-request-presigner', {
      requiredBy: '@setu-ts/storage-plugin',
      cause: error,
    });
  }
  return { s3: s3Mod, presigner: presignerMod };
}

/**
 * AWS S3 storage provider.
 *
 * Supports native streaming via the facade's `getStream` method.
 *
 * @since 0.1.0
 */
export class S3Provider implements StorageProvider {
  #client: IS3Backend | null = null;
  readonly #options: S3ProviderOptions;
  readonly #deadline: StorageDeadline;
  readonly #name: string;

  /**
   * @param options - S3 connection/injection options
   * @param internals - The provider name used in fault messages (`'s3'` or
   *   `'b2'`) and the runtime timer surface; `StoragePlugin` supplies both
   * @throws {RangeError} When `requestTimeoutMs` is out of range
   */
  constructor(
    options?: S3ProviderOptions,
    internals?: { readonly name?: string; readonly timing?: StorageDeadline['timing'] },
  ) {
    this.#options = options ?? { bucket: '' };
    this.#name = internals?.name ?? 's3';
    this.#deadline = {
      timeoutMs: resolveRequestTimeout(this.#options.requestTimeoutMs),
      ...(internals?.timing !== undefined && { timing: internals.timing }),
    };
  }

  /**
   * Runs one client call under the bound and classifies its rejection. The
   * bound covers the whole call, the body read included, and its signal is
   * handed to the client: the adapted client aborts its request and destroys
   * a body still streaming when the bound expires.
   */
  async #call<T>(
    operation: StorageOperation,
    run: (client: IS3Backend, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.#assertConnected();
    const client = this.#client!;
    try {
      return await runBounded(this.#deadline, this.#name, operation, (signal) =>
        run(client, signal),
      );
    } catch (error) {
      throw toStorageError(error, this.#name, operation);
    }
  }

  /**
   * Establishes the S3 client — injects the SDK lazily or uses injected client.
   */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateAwsS3Client(injected)) {
        throw new Error(
          'Injected S3 client is missing required methods (put, get, delete, head, getSignedUrl, getStream)',
        );
      }
      this.#client = injected;
      return;
    }
    this.#client = adaptAwsS3Module(
      await loadAwsS3Module(),
      this.#options,
      this.#deadline,
      this.#name,
    );
  }

  /** Disconnect is a no-op for S3 (connectionless HTTP client). */
  disconnect(): Promise<void> {
    this.#client = null;
    return Promise.resolve();
  }

  /** Reports readiness. */
  isReady(): boolean {
    return this.#client !== null;
  }

  /**
   * M70c: a `client.head('')`-shaped bucket probe using the existing `head`
   * member. Resolves `true` when the bucket answers, `false` when it does not
   * (or the provider is not connected).
   *
   * @returns `true` when the bucket is reachable
   * @since 0.1.0
   */
  async isHealthy(): Promise<boolean> {
    const client = this.#client;
    if (client === null) {
      return false;
    }
    try {
      return await client.head('');
    } catch {
      return false;
    }
  }

  #assertConnected(): void {
    if (this.#client === null) {
      throw new Error('S3Provider is not connected. Call connect() first.');
    }
  }

  /**
   * Stores an object in S3, recording any content type and user metadata on the
   * object itself — which is what makes a presigned URL render in a browser
   * instead of downloading as `application/octet-stream`.
   *
   * @param path - Object key
   * @param data - Object bytes
   * @param options - Object attributes to record with the bytes
   */
  async put(path: string, data: Uint8Array, options?: PutObjectOptions): Promise<void> {
    // Checked here too: the provider is exported and can be used directly.
    const refusal = storageKeyRefusal(path);
    if (refusal !== undefined) throw refusal;

    await this.#call('put', (client, signal) => client.put(path, data, options, signal));
  }

  /**
   * Retrieves an object from S3; `null` when absent.
   *
   * @param path - Object key
   * @returns The object bytes, or `null`
   */
  get(path: string): Promise<Uint8Array | null> {
    // Checked here too: the provider is exported and can be used directly.
    const refusal = storageKeyRefusal(path);
    if (refusal !== undefined) return Promise.reject(refusal);

    return this.#call('get', (client, signal) => client.get(path, signal));
  }

  /**
   * Deletes an object from S3. S3's `DeleteObject` answers alike whether or
   * not the key existed, so this method checks with `HEAD` first and resolves
   * `false` for an absent key, the answer every provider gives. A `403` on that
   * check, whatever its cause (a credential without `s3:ListBucket` gets one
   * for a missing key), leaves presence unknown, so the delete goes ahead: it
   * resolves `true` when it succeeds and rejects when it fails. Any other
   * `HEAD` failure rejects.
   *
   * @param path - Object key
   * @returns `false` only when the `HEAD` check showed no object was there;
   *   `true` when the delete succeeded otherwise, including a missing key under
   *   a credential without `s3:ListBucket` (grant it for exact answers)
   */
  async delete(path: string): Promise<boolean> {
    // Checked here too: the provider is exported and can be used directly.
    const refusal = storageKeyRefusal(path);
    if (refusal !== undefined) throw refusal;

    // Presence is a read of its own: its timeout is a 503 (nothing was sent).
    // A 403 there means the credential may not see absent keys (HeadObject
    // without `s3:ListBucket`), so presence is unknown and the delete goes on.
    let present: boolean;
    try {
      present = await this.#call('exists', (client, signal) => client.head(path, signal));
    } catch (error) {
      if (!(error instanceof Error) || answeredStatus(error.cause) !== 403) throw error;
      present = true;
    }
    if (!present) return false;
    return this.#call('delete', (client, signal) => client.delete(path, signal));
  }

  /**
   * Reports whether an object exists in S3: `false` only when S3 answers
   * not-found; an outage or a refused credential rejects.
   *
   * @param path - Object key
   * @returns `true` if present
   */
  exists(path: string): Promise<boolean> {
    // Checked here too: the provider is exported and can be used directly.
    const refusal = storageKeyRefusal(path);
    if (refusal !== undefined) return Promise.reject(refusal);

    return this.#call('exists', (client, signal) => client.head(path, signal));
  }

  /**
   * Creates a presigned GET URL for an S3 object.
   *
   * @param path - Object key
   * @param options - Expiry in seconds
   * @returns The presigned URL
   */
  getSignedUrl(path: string, options: { expiresIn: number }): Promise<string> {
    // Checked here too: the provider is exported and can be used directly.
    const refusal = storageKeyRefusal(path);
    if (refusal !== undefined) return Promise.reject(refusal);

    return this.#call('getSignedUrl', (client) => client.getSignedUrl(path, options.expiresIn));
  }

  /**
   * Native stream download — zero-copy from S3. The bound covers obtaining the
   * stream, not the transfer after it.
   *
   * @param path - Object key
   * @returns A `ReadableStream`, or `null` if absent
   */
  getStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    // Checked here too: the provider is exported and can be used directly.
    const refusal = storageKeyRefusal(path);
    if (refusal !== undefined) return Promise.reject(refusal);

    return this.#call('getStream', (client, signal) => client.getStream(path, signal));
  }
}
