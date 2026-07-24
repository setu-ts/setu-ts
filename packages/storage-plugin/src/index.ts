/**
 * `@hono-enterprise/storage-plugin` — file/object storage with pluggable
 * providers (memory, local FS, S3, GCS, Azure Blob) and an upload middleware.
 *
 * Registers {@linkcode IStorage} under `CAPABILITIES.STORAGE`.
 *
 * @module
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
export { AzureBlobProvider } from './providers/azure-provider.ts';

// ── Middleware & helper ───────────────────────────────────────────────────

export { createUploadMiddleware, getUploadedFile } from './middleware/upload-middleware.ts';

// ── Types (options, facades, uploaded file) ───────────────────────────────

export type {
  AzureBlobProviderOptions,
  GcsProviderOptions,
  IAwsS3Client,
  IAzureBlobClient,
  IGcsClient,
  LocalStorageProviderOptions,
  S3ProviderOptions,
  StoragePluginOptions,
  StorageProviderOptions,
  StorageProviderType,
  UploadedFile,
  UploadMiddlewareOptions,
} from './interfaces/index.ts';

// ── Re-export common contracts ────────────────────────────────────────────

export type { IStorage, SignedUrlOptions } from '@hono-enterprise/common';
