/**
 * @module
 *
 * `@setu-ts/storage-plugin` — file/object storage with pluggable
 * providers (memory, local FS, S3, GCS, Azure Blob) and an upload middleware.
 *
 * Registers {@linkcode IStorage} under `CAPABILITIES.STORAGE`.
 */

// ── Plugin factory ────────────────────────────────────────────────────────

export { StoragePlugin } from './plugin/storage-plugin.ts';

// ── Service ───────────────────────────────────────────────────────────────

export { StorageService } from './services/storage-service.ts';

// ── Providers ─────────────────────────────────────────────────────────────

export { MemoryProvider } from './providers/memory-provider.ts';
export { LocalStorageProvider } from './providers/local-provider.ts';
export { S3Provider } from './providers/s3-provider.ts';
export { GcsProvider } from './providers/gcs-provider.ts';
export { AzureBlobProvider, canSign } from './providers/azure-provider.ts';

// ── Middleware & helper ───────────────────────────────────────────────────

export { createUploadMiddleware, getUploadedFile } from './middleware/upload-middleware.ts';

// ── Types (options, facades, uploaded file) ───────────────────────────────

export type {
  AzureBlobProviderOptions,
  AzureStorageOptions,
  GcsProviderOptions,
  GcsStorageOptions,
  IAzureBlobClient,
  IGcsClient,
  IS3Backend,
  /**
   * @deprecated Renamed to {@linkcode IS3Backend} in 0.3.0 (M70k, X8-10). The
   * old name promised an `@aws-sdk/client-s3` client; the type is the
   * provider's own backend surface and a real `S3Client` never satisfied it.
   * Kept as an alias per AI_GUIDELINES §9.2 — the replacement is a working,
   * identical shape, so a rename does not need to be a compile error.
   */
  IS3Backend as IAwsS3Client,
  LocalStorageOptions,
  LocalStorageProviderOptions,
  MemoryStorageOptions,
  S3ProviderOptions,
  S3StorageOptions,
  StoragePluginOptions,
  StorageProviderOptions,
  StorageProviderType,
  UploadedFile,
  UploadMiddlewareOptions,
} from './interfaces/index.ts';

// ── Re-export common contracts ────────────────────────────────────────────

export type { IStorage, PutObjectOptions, SignedUrlOptions } from '@setu-ts/common';
