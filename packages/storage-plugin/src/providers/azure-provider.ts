/**
 * AzureBlobProvider — Azure Blob Storage via lazy `npm:@azure/storage-blob@^12`.
 *
 * Follows the M25 inject-or-lazy pattern. Key-based auth — single package,
 * no `@azure/identity` needed for core operations.
 *
 * @module
 */
import type { IAzureBlobClient, StorageProvider } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';

// ── SDK module shapes ─────────────────────────────────────────────────────

/** Shape of the Azure Blob SDK module. */
export interface AzureSdkModule {
  BlobServiceClient: new (urlOrConnectionString: string, cred?: unknown) => {
    getContainerClient(containerName: string): AzureContainer;
  };
  StorageSharedKeyCredential: new (accountName: string, accountKey: string) => {
    accountName: string;
    accountKey: string;
  };
  generateBlobSASQueryParameters: (
    values: { containerName: string; blobName: string; permissions: string; expiresOn: Date },
    credential: StorageSharedKeyCredential,
  ) => SASResult;
}

/** Parameters for SAS generation (values only, no credential). */
export interface GenerateSASValues {
  containerName: string;
  blobName: string;
  permissions: string;
  expiresOn: Date;
}

/** Azure shared-key credential shape. */
export interface StorageSharedKeyCredential {
  accountName: string;
  accountKey: string;
}

/** SAS query result. */
export interface SASResult {
  toString(): string;
}

/** Shape of an Azure container handle. */
export interface AzureContainer {
  getBlockBlobClient(blobName: string): AzureBlob;
}

/** Shape of an Azure block blob handle. */
export interface AzureBlob {
  uploadData(data: Uint8Array, options?: Record<string, unknown>): Promise<unknown>;
  download(offset?: number, length?: number): Promise<{
    deleted: boolean;
    readableStreamBody: NodeJS.ReadableStream;
    contentLength: number;
  }>;
  delete(options?: Record<string, unknown>): Promise<void>;
  exists(): Promise<boolean>;
}

/** Download result shape shared by the facade blob's `download`/`get`/`getStream`. */
export interface AzureDownloadResult {
  deleted: boolean;
  readableStreamBody: NodeJS.ReadableStream;
  contentLength: number;
}

/**
 * Promise-style blob shape exposed by the {@linkcode adaptAzureModule} facade —
 * what {@linkcode AzureBlobProvider} operates against (`delete` resolves to a
 * boolean, unlike the raw SDK's `void`).
 */
export interface AzureFacadeBlob {
  uploadData(data: Uint8Array, options?: Record<string, unknown>): Promise<void>;
  download(offset?: number, length?: number): Promise<AzureDownloadResult>;
  delete(): Promise<boolean>;
  exists(): Promise<boolean>;
}

/** Container handle exposed by the facade. */
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
  /** Azure connection string (alternative to accountName + accountKey). */
  connectionString?: string | undefined;
  /** Azure storage account name. */
  accountName?: string | undefined;
  /** Azure storage account key (required for SAS signing). */
  accountKey?: string | undefined;
  /** Container name. */
  containerName: string;
  /** Injected client facade; bypasses the lazy SDK import. */
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
  return typeof error === 'object' && error !== null &&
    (error as { statusCode?: unknown }).statusCode === HTTP_NOT_FOUND;
}

// ── Shared-key credential resolver ────────────────────────────────────────

/**
 * Resolves `{ accountName, accountKey }` from provider options — directly, or
 * parsed from a connection string's `AccountName=`/`AccountKey=` segments.
 * Returns `null` when key-based SAS signing is not possible (e.g. managed
 * identity). Pure function — unit-tested without any SDK import. Shared by
 * {@linkcode canSign} and the facade's `getSignedUrl` so the resolution rule
 * lives in exactly one place.
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
 * Adapts the Azure SDK module to the structural {@linkcode IAzureBlobClient} facade. Pure — unit-tested with a fake
 * module.
 *
 * @param mod - The Azure SDK module (real or fake)
 * @param options - Azure connection options
 * @returns The facade wrapping a `BlobServiceClient`
 */
export function adaptAzureModule(
  mod: AzureSdkModule,
  options: AzureBlobProviderOptions,
  now: () => number = () => 0,
): IAzureBlobClient & { canSign: boolean } {
  const containerName = options.containerName;
  const serviceClient: unknown = ((): unknown => {
    if (options.connectionString) {
      return new mod.BlobServiceClient(options.connectionString);
    } else if (options.accountName && options.accountKey) {
      const cred = new mod.StorageSharedKeyCredential(
        options.accountName,
        options.accountKey,
      ) as { accountName: string; accountKey: string };
      return new mod.BlobServiceClient(
        `https://${options.accountName}.blob.core.windows.net`,
        cred,
      );
    } else {
      throw new Error(
        'AzureBlobProvider requires either options.connectionString or options.accountName + options.accountKey',
      );
    }
  })();

  const signingEnabled = canSign(options);

  return {
    getContainerClient(name: string): unknown {
      const container = (serviceClient as { getContainerClient: (n: string) => unknown })
        .getContainerClient(name);
      return {
        getBlockBlobClient(blobName: string) {
          const blob = (container as { getBlockBlobClient: (b: string) => unknown })
            .getBlockBlobClient(blobName);
          return {
            uploadData(data: Uint8Array, opts?: Record<string, unknown>): Promise<void> {
              return (blob as {
                uploadData: (d: Uint8Array, o?: Record<string, unknown>) => Promise<void>;
              }).uploadData(data, opts);
            },
            async download(offset?: number, length?: number) {
              try {
                return await (blob as {
                  download: (
                    o?: number,
                    l?: number,
                  ) => Promise<{
                    deleted: boolean;
                    readableStreamBody: NodeJS.ReadableStream;
                    contentLength: number;
                  }>;
                }).download(offset, length);
              } catch (error) {
                if (isAzureNotFound(error)) {
                  return {
                    deleted: true,
                    readableStreamBody: null as unknown as NodeJS.ReadableStream,
                    contentLength: 0,
                  };
                }
                throw error;
              }
            },
            delete(): Promise<boolean> {
              return (async () => {
                try {
                  await (blob as { delete: () => Promise<void> }).delete();
                  return true;
                } catch {
                  return false;
                }
              })();
            },
            exists(): Promise<boolean> {
              return (blob as { exists: () => Promise<boolean> }).exists();
            },
          };
        },
      };
    },
    getSignedUrl(blobName: string, expiresIn: number): Promise<string> {
      const creds = resolveAccountCredentials(options);
      if (creds === null) {
        throw new Error(
          'AzureBlobProvider.getSignedUrl requires an account key (accountName + accountKey, or a connection string containing AccountKey); managed-identity user-delegation SAS is not supported',
        );
      }
      const cred = new mod.StorageSharedKeyCredential(
        creds.accountName,
        creds.accountKey,
      ) as StorageSharedKeyCredential;
      const nowMs = now();
      const sasValues: GenerateSASValues = {
        containerName,
        blobName,
        permissions: 'r',
        expiresOn: new Date(nowMs + expiresIn * 1000),
      };
      // Real SDK: generateBlobSASQueryParameters(values, credential) — SYNCHRONOUS.
      const sas = mod.generateBlobSASQueryParameters(sasValues, cred);
      return Promise.resolve(
        `https://${creds.accountName}.blob.core.windows.net/${containerName}/${blobName}?${sas.toString()}`,
      );
    },
    canSign: signingEnabled,
  } as IAzureBlobClient & { canSign: boolean };
}

/**
 * Lazily imports the Azure Blob SDK. Only exercised on the lazy path.
 *
 * @returns The SDK module
 * @throws {Error} If the package cannot be resolved
 */
export async function loadAzureModule(): Promise<AzureSdkModule> {
  return await import('npm:@azure/storage-blob@^12') as unknown as AzureSdkModule;
}

/**
 * Azure Blob storage provider.
 *
 * Supports native streaming via `download().readableStreamBody` async-iterated into a web `ReadableStream`.
 *
 * @since 0.1.0
 */
export class AzureBlobProvider implements StorageProvider {
  #client: IAzureBlobClient & { canSign: boolean } | null = null;
  readonly #options: AzureBlobProviderOptions;
  readonly #now: () => number;

  /**
   * @param options - Azure connection/injection options
   * @param now - Wall-clock source (epoch ms) for SAS expiry. Injected by
   *   `createProvider` as `runtime.now()` (the only sanctioned clock outside
   *   `packages/runtime`). Defaults to `() => 0` for direct construction.
   */
  constructor(options?: AzureBlobProviderOptions, now: () => number = () => 0) {
    this.#options = options ?? { containerName: '' };
    this.#now = now;
  }

  /**
   * Establishes the Azure client — injects the SDK lazily or uses injected client.
   */
  connect(): Promise<void> {
    if (this.#client !== null) return Promise.resolve();
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateAzureBlobClient(injected)) {
        return Promise.reject(
          new Error(
            'Injected Azure client is missing required method (getContainerClient)',
          ),
        );
      }
      this.#client = { ...injected, canSign: true } as IAzureBlobClient & {
        canSign: boolean;
      };
      return Promise.resolve();
    }
    return loadAzureModule().then((mod) => {
      this.#client = adaptAzureModule(mod, this.#options, this.#now);
    });
  }

  /** Disconnect is a no-op for Azure (connectionless HTTP client). */
  disconnect(): Promise<void> {
    this.#client = null;
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

  #getContainer(): AzureFacadeContainer {
    return this.#client!.getContainerClient(this.#options.containerName) as AzureFacadeContainer;
  }

  #getBlockBlob(path: string): AzureFacadeBlob {
    return this.#getContainer().getBlockBlobClient(path);
  }

  /**
   * Stores an object in Azure Blob Storage.
   *
   * @param path - Object key
   * @param data - Object bytes
   */
  async put(path: string, data: Uint8Array): Promise<void> {
    this.#assertConnected();
    await this.#getBlockBlob(path).uploadData(data);
  }

  /**
   * Retrieves an object from Azure Blob Storage; `null` when absent.
   *
   * @param path - Object key
   * @returns The object bytes, or `null`
   */
  async get(path: string): Promise<Uint8Array | null> {
    this.#assertConnected();
    try {
      const result = await this.#getBlockBlob(path).download();
      if (result.deleted) return null;
      // Adapt Node Readable to Uint8Array via async iteration.
      const chunks: Uint8Array[] = [];
      for await (const chunk of result.readableStreamBody as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      return concatChunks(chunks);
    } catch (error) {
      if (isAzureNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Deletes an object from Azure Blob Storage.
   *
   * @param path - Object key
   * @returns `true` if deleted
   */
  delete(path: string): Promise<boolean> {
    this.#assertConnected();
    return this.#getBlockBlob(path).delete();
  }

  /**
   * Reports whether an object exists in Azure Blob Storage.
   *
   * @param path - Object key
   * @returns `true` if present
   */
  exists(path: string): Promise<boolean> {
    this.#assertConnected();
    return this.#getBlockBlob(path).exists();
  }

  /**
   * Creates a SAS URL for an Azure Blob.
   *
   * @param path - Object key
   * @param options - Expiry in seconds
   * @returns The SAS URL
   * @throws {Error} When no account key is configured
   */
  getSignedUrl(path: string, options: { expiresIn: number }): Promise<string> {
    this.#assertConnected();
    const client = this.#client!;
    if (!client.getSignedUrl) {
      throw new Error('AzureBlobProvider does not support signed URLs in this configuration');
    }
    return client.getSignedUrl(path, options.expiresIn);
  }

  /**
   * Native stream download — adapts Azure `readableStreamBody` (Node Readable)
   * into a web `ReadableStream` via async iteration.
   *
   * @param path - Object key
   * @returns A `ReadableStream`, or `null` if absent
   */
  async getStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    this.#assertConnected();
    try {
      const result = await this.#getBlockBlob(path).download();
      if (result.deleted) return null;
      const readable = result.readableStreamBody as AsyncIterable<Uint8Array>;
      return Promise.resolve(
        new ReadableStream({
          start(controller) {
            (async () => {
              for await (const chunk of readable) {
                controller.enqueue(chunk);
              }
              controller.close();
            })().catch((err) => controller.error(err));
          },
        }),
      );
    } catch (error) {
      if (isAzureNotFound(error)) return null;
      throw error;
    }
  }
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
