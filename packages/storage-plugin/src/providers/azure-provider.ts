/**
 * AzureBlobProvider — Azure Blob Storage via lazy `@azure/storage-blob`.
 *
 * Follows the M25 inject-or-lazy pattern. Key-based auth — single package,
 * no `@azure/identity` needed for core operations.
 *
 * @module
 */
import type { PutObjectOptions } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { IAzureBlobClient, StorageProvider } from '../interfaces/index.ts';
import { createEagerIterableStream } from './provider-stream.ts';
import { assertStorageKey } from '../services/storage-key.ts';
import { hasMethods } from './shape.ts';
import type { StorageDeadline, StorageOperation } from './fault.ts';
import {
  answeredBelow500,
  destroyOnAbort,
  resolveRequestTimeout,
  runBounded,
  toStorageError,
} from './fault.ts';

// ── SDK module shapes ─────────────────────────────────────────────────────

/** The service client the SDK builds; only `getContainerClient` is read. */
export interface AzureServiceClient {
  getContainerClient(containerName: string): AzureContainer;
}

/** Shape of the Azure Blob SDK module. */
export interface AzureSdkModule {
  BlobServiceClient: {
    new (url: string, credential?: unknown): AzureServiceClient;
    fromConnectionString(connectionString: string): AzureServiceClient;
  };
  StorageSharedKeyCredential: new (accountName: string, accountKey: string) => unknown;
}

/** Options every bounded Azure operation takes. */
export interface AzureOperationOptions {
  abortSignal?: AbortSignal;
}

/** Shape of an Azure container handle. */
export interface AzureContainer {
  getBlockBlobClient(blobName: string): AzureBlob;
  exists(options?: AzureOperationOptions): Promise<boolean>;
}

/** Download result shape shared by the SDK and the facade blob. */
export interface AzureDownloadResult {
  /** Set only by an injected client that reports an absent blob this way. */
  deleted?: boolean;
  readableStreamBody?: NodeJS.ReadableStream;
}

/** Shape of an Azure block blob handle. */
export interface AzureBlob {
  uploadData(data: Uint8Array, options?: Record<string, unknown>): Promise<unknown>;
  download(
    offset?: number,
    length?: number,
    options?: AzureOperationOptions,
  ): Promise<AzureDownloadResult>;
  delete(options?: AzureOperationOptions): Promise<unknown>;
  exists(options?: AzureOperationOptions): Promise<boolean>;
  generateSasUrl?(options: { permissions: string; expiresOn: Date }): Promise<string>;
}

/**
 * Promise-style blob shape the provider operates against — the SDK's own
 * `BlockBlobClient` satisfies it, and so does the lazily adapted facade.
 */
export type AzureFacadeBlob = AzureBlob;

/** Container handle the provider operates against. */
export interface AzureFacadeContainer {
  getBlockBlobClient(blobName: string): AzureFacadeBlob;
}

// ── Options ───────────────────────────────────────────────────────────────

/**
 * Options for {@linkcode AzureBlobProvider}.
 *
 * @since 0.1.0
 */
export interface AzureBlobProviderOptions {
  /**
   * Azure connection string, read by the SDK's `fromConnectionString`
   * (alternative to accountName + accountKey).
   */
  connectionString?: string | undefined;
  /** Azure storage account name. */
  accountName?: string | undefined;
  /** Azure storage account key (required for SAS signing). */
  accountKey?: string | undefined;
  /**
   * Blob service URL for the `accountName` + `accountKey` form, such as a
   * sovereign cloud, a private endpoint or Azurite
   * (`http://127.0.0.1:10000/devstoreaccount1`).
   *
   * @default `https://<accountName>.blob.core.windows.net`
   * @since 0.14.0
   */
  endpoint?: string | undefined;
  /**
   * Bound on each backend call, in milliseconds, including the SDK's own
   * retries. A read that does not settle in time rejects with
   * `BackendUnavailableError` (`503`), a write with
   * `BackendOutcomeUnknownError` (`504`). `0` disables the bound; anything
   * outside `0`–`2147483647` throws `RangeError` at construction.
   *
   * @default 30000
   * @since 0.14.0
   */
  requestTimeoutMs?: number | undefined;
  /** Container name. */
  containerName: string;
  /**
   * Injected client — an SDK `BlobServiceClient` works as is; bypasses the lazy
   * SDK import.
   */
  client?: IAzureBlobClient | undefined;
}

// ── Validation ────────────────────────────────────────────────────────────

const REQUIRED_AZURE_METHODS = ['getContainerClient'] as const;

/**
 * Validates that an injected object matches {@linkcode IAzureBlobClient}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 * @since 0.1.0
 */
export function validateAzureBlobClient(client: unknown): boolean {
  return hasMethods(client, REQUIRED_AZURE_METHODS);
}

// ── Not-found detector (structural, mirrors M25) ──────────────────────────

const HTTP_NOT_FOUND = 404;

/** Reports whether a caught error is an HTTP 404. */
export function isAzureNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { statusCode?: unknown }).statusCode === HTTP_NOT_FOUND
  );
}

// ── Shared-key credential resolver ────────────────────────────────────────

/**
 * Resolves `{ accountName, accountKey }` from provider options — directly, or
 * parsed from a connection string's `AccountName=`/`AccountKey=` segments.
 * Returns `null` when key-based SAS signing is not possible (e.g. a SAS
 * connection string or managed identity). Pure function.
 */
function resolveAccountCredentials(
  options: AzureBlobProviderOptions,
): { accountName: string; accountKey: string } | null {
  let accountName: string | undefined;
  let accountKey: string | undefined;

  if (options.accountName) accountName = options.accountName;
  if (options.accountKey) accountKey = options.accountKey;

  if (!accountName || !accountKey) {
    const cs = options.connectionString;
    if (cs) {
      const nameMatch = cs.match(/AccountName=([^;]+)/);
      const keyMatch = cs.match(/AccountKey=([^;]+)/);
      if (nameMatch) accountName ??= nameMatch[1];
      if (keyMatch) accountKey ??= keyMatch[1];
    }
  }

  if (!accountName || !accountKey) return null;
  return { accountName, accountKey };
}

/** Reports whether key-based SAS signing is possible for these options. */
export function canSign(options: AzureBlobProviderOptions): boolean {
  return resolveAccountCredentials(options) !== null;
}

// ── Adapt / Load seams ────────────────────────────────────────────────────

/**
 * Builds the SDK service client from the options: a connection string through
 * `BlobServiceClient.fromConnectionString`, or an account name and key against
 * `endpoint` (default `https://<account>.blob.core.windows.net`).
 *
 * @param mod - The Azure SDK module (real or fake)
 * @param options - Azure connection options
 * @returns The SDK service client
 * @throws {Error} When neither form is configured
 */
export function buildAzureServiceClient(
  mod: AzureSdkModule,
  options: AzureBlobProviderOptions,
): AzureServiceClient {
  if (options.connectionString) {
    return mod.BlobServiceClient.fromConnectionString(options.connectionString);
  }
  if (options.accountName && options.accountKey) {
    const credential = new mod.StorageSharedKeyCredential(options.accountName, options.accountKey);
    const url = options.endpoint ?? `https://${options.accountName}.blob.core.windows.net`;
    return new mod.BlobServiceClient(url, credential);
  }
  throw new Error(
    'AzureBlobProvider requires either options.connectionString or options.accountName + options.accountKey',
  );
}

/**
 * Adapts the Azure SDK module to the structural {@linkcode IAzureBlobClient}
 * facade: the SDK's own clients, each operation bounded and given the bound's
 * `abortSignal`, plus a container probe. Pure — unit-tested with a fake module.
 *
 * @param mod - The Azure SDK module (real or fake)
 * @param options - Azure connection options
 * @param deadline - The bound on each backend call
 * @returns The facade wrapping a `BlobServiceClient`
 */
export function adaptAzureModule(
  mod: AzureSdkModule,
  options: AzureBlobProviderOptions,
  deadline: StorageDeadline = { timeoutMs: resolveRequestTimeout(options.requestTimeoutMs) },
): IAzureBlobClient {
  const serviceClient = buildAzureServiceClient(mod, options);
  const bound = <T>(operation: StorageOperation, run: (signal: AbortSignal) => Promise<T>) =>
    runBounded(deadline, 'azure', operation, run);

  return {
    getContainerClient(name: string): unknown {
      const container = serviceClient.getContainerClient(name);
      return {
        getBlockBlobClient(blobName: string): AzureFacadeBlob {
          const blob = container.getBlockBlobClient(blobName);
          return {
            uploadData: (data, opts) =>
              bound('put', (abortSignal) => blob.uploadData(data, { ...opts, abortSignal })),
            download: (offset, length) =>
              bound('get', (abortSignal) => blob.download(offset, length, { abortSignal })),
            delete: () => bound('delete', (abortSignal) => blob.delete({ abortSignal })),
            exists: () => bound('exists', (abortSignal) => blob.exists({ abortSignal })),
            generateSasUrl: (sasOptions) => {
              const generate = blob.generateSasUrl;
              if (generate === undefined) {
                return Promise.reject(
                  new RangeError('this blob client holds no shared key to sign with'),
                );
              }
              return bound('getSignedUrl', () => generate.call(blob, sasOptions));
            },
          };
        },
      };
    },
    // Readiness: the container answered. A refused credential or a missing
    // container is an answer (status < 500); a network failure, the bound or a
    // 5xx is not.
    async isHealthy(): Promise<boolean> {
      try {
        await bound('probe', (abortSignal) =>
          serviceClient.getContainerClient(options.containerName).exists({ abortSignal }),
        );
        return true;
      } catch (error) {
        return answeredBelow500(error);
      }
    },
  };
}

/**
 * Lazily imports the Azure Blob SDK. Only exercised on the lazy path.
 *
 * @returns The SDK module
 * @throws {Error} If the package cannot be resolved
 */
export async function loadAzureModule(): Promise<AzureSdkModule> {
  try {
    return (await import('@azure/storage-blob')) as unknown as AzureSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@azure/storage-blob', {
      requiredBy: '@setu-ts/storage-plugin',
      cause: error,
    });
  }
}

/**
 * Azure Blob storage provider.
 *
 * Supports native streaming via `download().readableStreamBody` async-iterated
 * into a web `ReadableStream`. Every call runs under `requestTimeoutMs` and
 * every failure other than Azure's not-found answer is classified by
 * `toStorageError`.
 *
 * @since 0.1.0
 */
export class AzureBlobProvider implements StorageProvider {
  #client: IAzureBlobClient | null = null;
  readonly #options: AzureBlobProviderOptions;
  readonly #now: (() => number) | undefined;
  readonly #deadline: StorageDeadline;
  /**
   * Delegates to the client's optional `isHealthy?()` — the lazily adapted
   * client's probe calls the container client's `exists()`. Assigned in
   * `connect()` only when the client provides the member; a client that omits
   * it is *unknown*, and the indicator reads absence (not `false`) as that.
   *
   * @since 0.1.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param options - Azure connection/injection options
   * @param now - Wall-clock source (epoch ms) for SAS expiry. Injected by
   *   `createProvider` as `runtime.now()` (the only sanctioned clock outside
   *   `packages/runtime`). Without one, `getSignedUrl` rejects by name.
   * @param timing - The runtime timer surface for the bound (ambient timers
   *   when absent)
   * @throws {RangeError} When `requestTimeoutMs` is out of range
   */
  constructor(
    options?: AzureBlobProviderOptions,
    now?: () => number,
    timing?: StorageDeadline['timing'],
  ) {
    this.#options = options ?? { containerName: '' };
    this.#now = now;
    this.#deadline = {
      timeoutMs: resolveRequestTimeout(this.#options.requestTimeoutMs),
      ...(timing !== undefined && { timing }),
    };
  }

  /**
   * Establishes the Azure client — injects the SDK lazily or uses injected
   * client. An injected client is kept as given, so an SDK `BlobServiceClient`
   * keeps its methods.
   */
  connect(): Promise<void> {
    if (this.#client !== null) return Promise.resolve();
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateAzureBlobClient(injected)) {
        return Promise.reject(
          new Error('Injected Azure client is missing required method (getContainerClient)'),
        );
      }
      this.#client = injected;
      this.#installProbe();
      return Promise.resolve();
    }
    return loadAzureModule().then((mod) => {
      this.#client = adaptAzureModule(mod, this.#options, this.#deadline);
      this.#installProbe();
    });
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

  /** Disconnect is a no-op for Azure (connectionless HTTP client). */
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
      throw new Error('AzureBlobProvider is not connected. Call connect() first.');
    }
  }

  #getBlockBlob(path: string): AzureFacadeBlob {
    // Checked here too: the provider is exported and can be used directly, and
    // the SDK resolves a '..' segment before it sends or signs.
    assertStorageKey(path);
    const container = this.#client!.getContainerClient(
      this.#options.containerName,
    ) as AzureFacadeContainer;
    return container.getBlockBlobClient(path);
  }

  /**
   * Runs one call under the bound — the whole call, a body read included — and
   * classifies its rejection. `run` receives the bound's signal (a body still
   * streaming is destroyed when it expires); the adapted client also hands each
   * SDK operation a signal of its own. `notFound` names the value Azure's
   * not-found answer stands for.
   */
  async #call<T>(
    operation: StorageOperation,
    run: (signal: AbortSignal) => Promise<T>,
    notFound?: { readonly value: T },
  ): Promise<T> {
    this.#assertConnected();
    try {
      return await runBounded(this.#deadline, 'azure', operation, run);
    } catch (error) {
      if (notFound !== undefined && isAzureNotFound(error)) return notFound.value;
      throw toStorageError(error, 'azure', operation);
    }
  }

  /**
   * Stores an object in Azure Blob Storage, recording any content type and user
   * metadata on the blob so a SAS URL serves it under the right type.
   *
   * Azure carries the content type inside `blobHTTPHeaders` rather than beside
   * the metadata, so the two land in different places on the same call.
   *
   * @param path - Object key
   * @param data - Object bytes
   * @param options - Object attributes to record with the bytes
   */
  put(path: string, data: Uint8Array, options?: PutObjectOptions): Promise<void> {
    const uploadOptions: Record<string, unknown> = {
      ...(options?.contentType === undefined
        ? {}
        : { blobHTTPHeaders: { blobContentType: options.contentType } }),
      ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
    };
    return this.#call('put', async () => {
      await this.#getBlockBlob(path).uploadData(data, uploadOptions);
    });
  }

  /**
   * Retrieves an object from Azure Blob Storage; `null` when absent.
   *
   * @param path - Object key
   * @returns The object bytes, or `null`
   */
  get(path: string): Promise<Uint8Array | null> {
    return this.#call<Uint8Array | null>(
      'get',
      async (signal) => {
        const result = await this.#getBlockBlob(path).download();
        if (result.deleted === true || result.readableStreamBody === undefined) return null;
        // A body still streaming when the bound expires is destroyed, so it
        // releases its connection.
        destroyOnAbort(result.readableStreamBody, signal);
        // Adapt Node Readable to Uint8Array via async iteration.
        const chunks: Uint8Array[] = [];
        for await (const chunk of result.readableStreamBody as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
        }
        return concatChunks(chunks);
      },
      { value: null },
    );
  }

  /**
   * Deletes an object from Azure Blob Storage: `false` when Azure answers
   * not-found; an outage or a refused credential rejects.
   *
   * @param path - Object key
   * @returns `true` if deleted
   */
  delete(path: string): Promise<boolean> {
    return this.#call(
      'delete',
      async () => {
        // An SDK client resolves a response; an injected facade may resolve
        // `false` for an absent blob, the facade contract before 0.14.0.
        const result = await this.#getBlockBlob(path).delete();
        return result !== false;
      },
      { value: false },
    );
  }

  /**
   * Reports whether an object exists in Azure Blob Storage: `false` only when
   * Azure says so; an outage or a refused credential rejects.
   *
   * @param path - Object key
   * @returns `true` if present
   */
  exists(path: string): Promise<boolean> {
    return this.#call('exists', () => this.#getBlockBlob(path).exists(), { value: false });
  }

  /**
   * Creates a read-only SAS URL for a blob through the SDK's `generateSasUrl`,
   * which encodes the blob name and uses the client's own host. An injected
   * facade's own `getSignedUrl` is used when it has one.
   *
   * @param path - Object key
   * @param options - Expiry in seconds
   * @returns The SAS URL
   * @throws {Error} (as a rejection) When the provider is not connected, has no
   *   clock, or its client holds no account key to sign with
   */
  getSignedUrl(path: string, options: { expiresIn: number }): Promise<string> {
    if (this.#client === null) {
      return Promise.reject(new Error('AzureBlobProvider is not connected. Call connect() first.'));
    }
    const now = this.#now;
    if (now === undefined) {
      return Promise.reject(
        new Error(
          'AzureBlobProvider.getSignedUrl needs a clock: pass now to the constructor, or ' +
            'register the provider through StoragePlugin',
        ),
      );
    }
    return this.#call('getSignedUrl', async () => {
      const client = this.#client!;
      if (client.getSignedUrl !== undefined) {
        return client.getSignedUrl(path, options.expiresIn);
      }
      const blob = this.#getBlockBlob(path);
      if (typeof blob.generateSasUrl !== 'function') throw signingRefusal();
      try {
        return await blob.generateSasUrl({
          permissions: 'r',
          expiresOn: new Date(now() + options.expiresIn * 1000),
        });
      } catch (error) {
        // The SDK refuses with a RangeError naming the shared key when the
        // client holds none; any other error (a bad expiry) passes through.
        if (error instanceof RangeError && /shared key/i.test(error.message)) {
          throw signingRefusal(error);
        }
        throw error;
      }
    });
  }

  /**
   * Native stream download — adapts Azure `readableStreamBody` (Node Readable)
   * into a web `ReadableStream` via async iteration. The bound covers obtaining
   * the stream, not the transfer after it.
   *
   * Cancellation-safe: the stream's `cancel` hook releases the iterator and
   * destroys the underlying request. Still an EAGER drain by documented
   * contract — see `provider-stream.ts` and the README's per-provider table.
   *
   * @param path - Object key
   * @returns A `ReadableStream`, or `null` if absent
   */
  getStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    return this.#call<ReadableStream<Uint8Array> | null>(
      'getStream',
      async () => {
        const result = await this.#getBlockBlob(path).download();
        if (result.deleted === true || result.readableStreamBody === undefined) return null;
        const readable = result.readableStreamBody as unknown as AsyncIterable<Uint8Array>;
        return createEagerIterableStream(readable);
      },
      { value: null },
    );
  }
}

/** The refusal for a client that cannot sign a SAS URL. */
function signingRefusal(cause?: unknown): Error {
  return new Error(
    'AzureBlobProvider.getSignedUrl requires an account key (accountName + accountKey, or a connection string containing AccountKey); managed-identity user-delegation SAS is not supported',
    cause === undefined ? undefined : { cause },
  );
}

/** Concatenates an array of Uint8Array chunks into a single Uint8Array. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
