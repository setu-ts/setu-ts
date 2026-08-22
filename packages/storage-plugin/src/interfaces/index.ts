/**
 * Internal types and structural facades for the StoragePlugin.
 *
 * The `StorageProvider` port is the internal adapter interface — NOT exported
 * from `src/index.ts`.  Structural client facades (`IAwsS3Client`, etc.) are
 * exported so consumers can inject a fake SDK for testing.
 *
 * @module
 */

import type { PutObjectOptions } from '@setu-ts/common';

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
 * Top-level options passed to {@linkcode StoragePlugin}: a union discriminated
 * on `provider`, so each backend's `options` are checked against that backend's
 * own shape.
 *
 * The memory arm keeps `provider` OPTIONAL, so an omitted provider still means
 * `'memory'` and `StoragePlugin()` is unchanged.
 *
 * Before this was discriminated, one unknown key made the compiler report EVERY
 * property of the literal as `not assignable to type 'never'` and never named
 * the offending one — the union's first member was `Record<string, never>`,
 * which accepts any object shape while requiring every property to be `never`,
 * so a literal matching no other member bound to it. Discriminating also makes
 * a missing `bucket` or `containerName` a compile error under the arm that
 * requires it, rather than something only the running backend notices.
 *
 * @since 0.1.0
 */
export type StoragePluginOptions =
  | MemoryStorageOptions
  | LocalStorageOptions
  | S3StorageOptions
  | GcsStorageOptions
  | AzureStorageOptions;

/**
 * The default arm: in-memory storage, which takes no configuration.
 *
 * It deliberately declares NO `options` member. The previous
 * `MemoryProviderOptions = Record<string, never>` is what produced X8-11's
 * symptom, and discriminating the outer union alone did NOT remove it —
 * measured: with that member present, one unknown key inside an `'s3'` literal
 * still reported `bucket` and `region` as `not assignable to type 'never'`,
 * because the compiler keeps every arm's `options` type as a candidate for the
 * nested literal once the direct match fails. Without it there is exactly one
 * error, and it names the offending key.
 */
export interface MemoryStorageOptions {
  /** Selects the memory backend. Optional — an omitted provider means memory. */
  readonly provider?: 'memory';
}

/** The local-filesystem arm. */
export interface LocalStorageOptions {
  /** Selects the local-filesystem backend. */
  readonly provider: 'local';
  /** Root directory configuration. */
  readonly options?: LocalStorageProviderOptions;
}

/**
 * The S3 arm, shared by `'s3'` and the `'b2'` (Backblaze) preset, which reaches
 * the same provider over B2's S3-compatible endpoint.
 */
export interface S3StorageOptions {
  /** Selects the S3 backend, or the Backblaze B2 preset over it. */
  readonly provider: 's3' | 'b2';
  /** Bucket and credentials; `bucket` is required. */
  readonly options: S3ProviderOptions;
}

/** The Google Cloud Storage arm. */
export interface GcsStorageOptions {
  /** Selects the GCS backend. */
  readonly provider: 'gcs';
  /** Bucket and project; `bucket` is required. */
  readonly options: GcsProviderOptions;
}

/** The Azure Blob Storage arm. */
export interface AzureStorageOptions {
  /** Selects the Azure Blob backend. */
  readonly provider: 'azure';
  /** Container and credentials; `containerName` is required. */
  readonly options: AzureBlobProviderOptions;
}

/**
 * Union of per-provider option shapes.
 *
 * Retained as a named type because it is the parameter type of the internal
 * provider factory and appears in the package's documented surface; the arm a
 * configuration takes is selected by {@linkcode StoragePluginOptions}, never by
 * matching against this union.
 *
 * @since 0.1.0
 */
export type StorageProviderOptions =
  | LocalStorageProviderOptions
  | S3ProviderOptions
  | GcsProviderOptions
  | AzureBlobProviderOptions;

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
  put(path: string, data: Uint8Array, options?: PutObjectOptions): Promise<void>;
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
  /**
   * M70c: resolves when the bucket is reachable — the real adapter calls
   * `bucket.exists()`. Optional so a minimal injected fake still type-checks.
   *
   * @since 0.1.0
   */
  isHealthy?(): Promise<boolean>;
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
  /**
   * M70c: resolves when the container is reachable — the real adapter calls the
   * container client's `exists()`. Optional so a minimal injected fake still
   * type-checks.
   *
   * @since 0.1.0
   */
  isHealthy?(): Promise<boolean>;
}

// ── Uploaded file shape ───────────────────────────────────────────────────

/**
 * A single parsed file from a multipart upload.
 *
 * @since 0.1.0
 */
export interface UploadedFile {
  /** The form field name the file was uploaded under (Content-Disposition `name="…"`). */
  readonly name: string;
  /**
   * The client-provided original file name (Content-Disposition `filename="…"`).
   * Falls back to the field name when the client sent no `filename`.
   */
  readonly filename: string;
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
   * @param options - Object attributes to record with the bytes. Providers that
   * cannot persist them accept and ignore them; see the README's per-provider
   * table.
   */
  put(path: string, data: Uint8Array, options?: PutObjectOptions): Promise<void>;
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
  /**
   * M70c: reports whether the provider's backend is reachable right now, for
   * the plugin's health indicator.
   *
   * Optional: a provider with no meaningful liveness check omits it, and the
   * indicator then reports only the lifecycle state (`isReady`). This answers a
   * fact (reachability), not a policy: the indicator owns the `up`/`down`
   * mapping.
   *
   * @returns `true` when the backend is reachable
   * @since 0.1.0
   */
  isHealthy?(): Promise<boolean>;
}
