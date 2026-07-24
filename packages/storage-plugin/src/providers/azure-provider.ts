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
    params: GenerateSASParams,
  ) => Promise<SASResult>;
}

/** Parameters for SAS generation. */
export interface GenerateSASParams {
  containerName: string;
  blobName: string;
  permissions: string;
  expiresOn: Date;
  credential: unknown;
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
  download(offset?: number, length?: number): {
    deleted: boolean;
    readableStreamBody: NodeJS.ReadableStream;
    contentLength: number;
  };
  delete(options?: Record<string, unknown>): Promise<void>;
  exists(): Promise<boolean>;
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
 * Resolves a `StorageSharedKeyCredential` from provider options, or returns `null`
 * when the configuration does not support key-based signing (e.g. managed identity).
/**
 * Resolves whether signing credentials are available from provider options.
 * Pure function — unit-tested without requiring any SDK import.
 */
export function canSign(options: AzureBlobProviderOptions): boolean {
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

  return !!accountName && !!accountKey;
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
): IAzureBlobClient & { canSign: boolean } {
  const containerName = options.containerName;
  const serviceClient: unknown = ((): unknown => {
    if (options.connectionString) {
      return new mod.BlobServiceClient(options.connectionString);
    } else if (options.accountName && options.accountKey) {
      // deno-lint-ignore no-explicit-any
      const cred = new mod.StorageSharedKeyCredential(
        options.accountName,
        options.accountKey,
      ) as any;
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
            download(offset?: number, length?: number) {
              try {
                return (blob as {
                  download: (
                    o?: number,
                    l?: number,
                  ) => {
                    deleted: boolean;
                    readableStreamBody: NodeJS.ReadableStream;
                    contentLength: number;
                  };
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
    async getSignedUrl(blobName: string, expiresIn: number): Promise<string> {
      if (!signingEnabled) {
        throw new Error(
          'AzureBlobProvider.getSignedUrl requires an account key (accountName + accountKey, or a connection string containing AccountKey); managed-identity user-delegation SAS is not supported',
        );
      }
      const sasParams = {
        containerName,
        blobName,
        permissions: 'r',
        expiresOn: new Date(Date.now() + expiresIn * 1000),
        // deno-lint-ignore no-explicit-any
        credential: null as any,
      };
      const sas = await mod.generateBlobSASQueryParameters(sasParams as GenerateSASParams);
      return `https://${options.accountName}.blob.core.windows.net/${containerName}/${blobName}?${sas.toString()}`;
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

  /**
   * @param options - Azure connection/injection options
   */
  constructor(options?: AzureBlobProviderOptions) {
    this.#options = options ?? { containerName: '' };
  }

  /**
   * Establishes the Azure client — injects the SDK lazily or uses injected client.
   */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateAzureBlobClient(injected)) {
        throw new Error(
          'Injected Azure client is missing required method (getContainerClient)',
        );
      }
      // deno-lint-ignore no-explicit-any
      this.#client = { ...injected as any, canSign: true } as IAzureBlobClient & {
        canSign: boolean;
      };
      return;
    }
    this.#client = adaptAzureModule(await loadAzureModule(), this.#options);
  }

  /** Disconnect is a no-op for Azure (connectionless HTTP client). */
  async disconnect(): Promise<void> {
    this.#client = null;
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

  #getContainer() {
    // deno-lint-ignore no-explicit-any
    return this.#client!.getContainerClient(this.#options.containerName) as any;
  }

  #getBlockBlob(path: string) {
    // deno-lint-ignore no-explicit-any
    return (this.#getContainer() as any).getBlockBlobClient(path);
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
      const result = this.#getBlockBlob(path).download();
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
      const result = this.#getBlockBlob(path).download();
      if (result.deleted) return null;
      return new ReadableStream({
        start(controller) {
          const readable = result.readableStreamBody as AsyncIterable<Uint8Array>;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          (async () => {
            for await (const chunk of readable) {
              controller.enqueue(chunk);
            }
            controller.close();
          })().catch((err) => controller.error(err));
        },
      });
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
