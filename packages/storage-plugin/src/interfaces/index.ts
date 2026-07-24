/**
 * Internal types and structural facades for the StoragePlugin.
 *
 * The `StorageProvider` port is the internal adapter interface — NOT exported
 * from `src/index.ts`.  Structural client facades (`IAwsS3Client`, etc.) are
 * exported so consumers can inject a fake SDK for testing.
 *
 * @module
 */

// ── Provider type discriminant ────────────────────────────────────────────

/** Supported storage back-ends. */
export type StorageProviderType =
  | 'memory'
  | 'local'
  | 's3'
  | 'gcs'
  | 'azure'
  | 'b2';

// ── Plugin / provider options ─────────────────────────────────────────────

/**
 * Top-level options passed to {@linkcode StoragePlugin}.
 *
 * @since 0.1.0
 */
export interface StoragePluginOptions {
  /** Provider backend (default `'memory'`). */
  provider?: StorageProviderType;
  /** Provider-specific options. */
  options?: StorageProviderOptions;
}

/**
 * Union of per-provider option shapes, keyed by which fields are present.
 *
 * @since 0.1.0
 */
export type StorageProviderOptions =
  | MemoryProviderOptions
  | LocalStorageProviderOptions
  | S3ProviderOptions
  | GcsProviderOptions
  | AzureBlobProviderOptions;

/** Options for {@linkcode MemoryProvider}. */
export type MemoryProviderOptions = Record<string, never>;

/** Options for {@linkcode LocalStorageProvider}. */
export interface LocalStorageProviderOptions {
  /** Root directory for stored objects. */
  rootDir?: string;
}

/** Options for {@linkcode S3Provider} (and `'b2'` preset). */
export interface S3ProviderOptions {
  /** AWS region. */
  region?: string;
  /** Bucket name. */
  bucket: string;
  /** AWS access key ID. */
  accessKeyId?: string;
  /** AWS secret access key. */
  secretAccessKey?: string;
  /** Custom S3-compatible endpoint (R2, MinIO, B2). */
  endpoint?: string;
  /** Injected structural client (bypasses lazy import). */
  client?: IAwsS3Client;
}

/** Options for {@linkcode GcsProvider}. */
export interface GcsProviderOptions {
  /** GCP project ID. */
  projectId?: string;
  /** Bucket name. */
  bucket: string;
  /** Injected structural client (bypasses lazy import). */
  client?: IGcsClient;
}

/** Options for {@linkcode AzureBlobProvider}. */
export interface AzureBlobProviderOptions {
  /** Azure connection string (alternative to accountName + accountKey). */
  connectionString?: string;
  /** Azure storage account name. */
  accountName?: string;
  /** Azure storage account key (required for SAS signing). */
  accountKey?: string;
  /** Container name. */
  containerName: string;
  /** Injected structural client (bypasses lazy import). */
  client?: IAzureBlobClient;
}

// ── Structural client facades (exported for injection) ────────────────────

/**
 * Minimal S3 client shape for structural injection.
 * Exposes data-methods directly (adaptAwsS3Module builds them from SDK commands).
 *
 * @since 0.1.0
 */
export interface IAwsS3Client {
  put(path: string, data: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array | null>;
  delete(path: string): Promise<boolean>;
  head(path: string): Promise<boolean>;
  getSignedUrl(path: string, expiresIn: number): Promise<string>;
  getStream(path: string): Promise<ReadableStream<Uint8Array> | null>;
}

/**
 * Minimal GCS client shape for structural injection.
 *
 * @since 0.1.0
 */
export interface IGcsClient {
  bucket(_name?: string): unknown;
}

/**
 * Minimal Azure Blob client shape for structural injection.
 *
 * @since 0.1.0
 */
export interface IAzureBlobClient {
  getContainerClient(_name: string): unknown;
  /** Creates a SAS-signed URL. Added by adaptAzureModule internally. */
  getSignedUrl?(_path: string, _expiresIn: number): Promise<string>;
}

// ── Uploaded file shape ───────────────────────────────────────────────────

/**
 * A single parsed file from a multipart upload.
 *
 * @since 0.1.0
 */
export interface UploadedFile {
  /** Original file name. */
  readonly name: string;
  /** File bytes. */
  readonly data: Uint8Array;
  /** MIME type reported by the client. */
  readonly mimeType: string;
  /** File size in bytes. */
  readonly size: number;
}

/**
 * Options for the upload middleware factory.
 *
 * @since 0.1.0
 */
export interface UploadMiddlewareOptions {
  /** Form field name to extract (default `'file'`). */
  fieldname?: string;
  /** Maximum per-file size in bytes (default 10 MB). */
  maxSize?: number;
  /** Allowed MIME-type allow-list (optional). */
  allowedMimeTypes?: readonly string[];
  /** Maximum number of files (default unlimited). */
  maxFiles?: number;
}

// ── Internal provider port (NOT exported from barrel) ─────────────────────

/**
 * Internal provider port. NOT exported from `src/index.ts` — the committed
 * public contract is `IStorage`; providers are an internal seam behind
 * {@linkcode StorageService}. `get`/`getStream` return `null` when absent.
 *
 * @since 0.1.0
 */
export interface StorageProvider {
  /** Establishes any backing connection/client. No-op for stateless providers. */
  connect(): Promise<void>;
  /** Releases any backing connection/client. No-op for stateless providers. */
  disconnect(): Promise<void>;
  /** Reports whether the provider is ready to serve reads. */
  isReady(): boolean;
  /**
   * Stores an object.
   *
   * @param path - Object path/key
   * @param data - Object bytes
   */
  put(path: string, data: Uint8Array): Promise<void>;
  /**
   * Retrieves an object; `null` when absent.
   *
   * @param path - Object path/key
   * @returns The object bytes, or `null`
   */
  get(path: string): Promise<Uint8Array | null>;
  /**
   * Deletes an object.
   *
   * @param path - Object path/key
   * @returns `true` if an object was deleted
   */
  delete(path: string): Promise<boolean>;
  /**
   * Reports whether an object exists.
   *
   * @param path - Object path/key
   * @returns `true` if present
   */
  exists(path: string): Promise<boolean>;
  /**
   * Creates a time-limited URL granting direct access to an object.
   *
   * @param path - Object path/key
   * @param options - URL validity
   * @returns The signed URL
   */
  getSignedUrl(path: string, options: { expiresIn: number }): Promise<string>;
  /**
   * Native streaming download seam; `null` when the provider has no native
   * stream support (the service falls back to buffering {@linkcode get}).
   *
   * @param path - Object path/key
   * @returns A `ReadableStream` of object bytes, or `null`
   */
  getStream?(path: string): Promise<ReadableStream<Uint8Array> | null>;
}
