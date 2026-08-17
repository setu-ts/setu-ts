/**
 * StoragePlugin — registers an {@linkcode IStorage} under
 * `CAPABILITIES.STORAGE`, backed by a pluggable provider.
 *
 * @module
 */
import type {
  HealthCheckResult,
  IPlugin,
  IPluginContext,
  IRuntimeServices,
  IStorage,
} from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type {
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
} from '../interfaces/index.ts';
import type { StorageProvider } from '../interfaces/index.ts';
import { StorageService } from '../services/storage-service.ts';
import { MemoryProvider } from '../providers/memory-provider.ts';
import { LocalStorageProvider } from '../providers/local-provider.ts';
import { S3Provider } from '../providers/s3-provider.ts';
import { GcsProvider } from '../providers/gcs-provider.ts';
import { AzureBlobProvider } from '../providers/azure-provider.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'storage-plugin';

/** Default provider backend. */
const DEFAULT_PROVIDER: StorageProviderType = 'memory';

/**
 * Builds the provider adapter for the configured backend.
 *
 * @param type - The provider backend id
 * @param options - Provider-specific options
 * @param runtime - The runtime environment services (for `LocalStorageProvider`)
 * @returns The provider adapter
 * @throws {Error} If the provider type is unsupported
 */
export function createProvider(
  type: StorageProviderType,
  options: StorageProviderOptions,
  runtime: IRuntimeServices,
): unknown {
  // Wall-clock source for providers that compute signed-URL expiry. `runtime.now()`
  // is the only sanctioned clock outside `packages/runtime` (no direct platform clock).
  const now = (): number => runtime.now();

  switch (type) {
    case 'memory':
      return new MemoryProvider(now);

    case 'local': {
      const localOpts = options as LocalStorageProviderOptions;
      return new LocalStorageProvider(runtime.fs, localOpts);
    }

    case 's3': {
      const s3Opts = options as S3ProviderOptions;
      return new S3Provider({
        region: s3Opts.region,
        bucket: s3Opts.bucket,
        accessKeyId: s3Opts.accessKeyId,
        secretAccessKey: s3Opts.secretAccessKey,
        endpoint: s3Opts.endpoint,
        client: s3Opts.client as IAwsS3Client | undefined,
      });
    }

    case 'b2': {
      // Backblaze B2: first-class S3-compatible preset.
      const b2Opts = options as S3ProviderOptions;
      const region = b2Opts.region ?? 'us-east-1';
      const endpoint = b2Opts.endpoint ?? `https://s3.${region}.backblazeb2.com`;
      return new S3Provider({
        region,
        bucket: b2Opts.bucket,
        accessKeyId: b2Opts.accessKeyId,
        secretAccessKey: b2Opts.secretAccessKey,
        endpoint,
        client: b2Opts.client as IAwsS3Client | undefined,
      });
    }

    case 'gcs': {
      const gcsOpts = options as GcsProviderOptions;
      return new GcsProvider({
        projectId: gcsOpts.projectId,
        bucket: gcsOpts.bucket,
        client: gcsOpts.client as IGcsClient | undefined,
      }, now);
    }

    case 'azure': {
      const azureOpts = options as AzureBlobProviderOptions;
      return new AzureBlobProvider({
        connectionString: azureOpts.connectionString,
        accountName: azureOpts.accountName,
        accountKey: azureOpts.accountKey,
        containerName: azureOpts.containerName,
        client: azureOpts.client as IAzureBlobClient | undefined,
      }, now);
    }

    default:
      throw new Error(`Unsupported storage provider: ${type as string}`);
  }
}

/**
 * Creates the StoragePlugin.
 *
 * Registers an {@linkcode IStorage} under `CAPABILITIES.STORAGE`. The
 * default provider is `'memory'` (zero dependency, every runtime).
 *
 * @example
 * ```typescript
 * import { StoragePlugin } from '@setu-ts/storage-plugin';
 *
 * // In-memory (default)
 * app.register(StoragePlugin());
 *
 * // AWS S3
 * app.register(StoragePlugin({
 *   provider: 's3',
 *   options: { bucket: 'my-bucket', region: 'us-east-1' },
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 */
export function StoragePlugin(options?: StoragePluginOptions): IPlugin {
  const providerType = options?.provider ?? DEFAULT_PROVIDER;
  const providerOptions = options?.options ?? {};

  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    optionalDependencies: ['logger', 'health'],
    provides: [CAPABILITIES.STORAGE],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const rawProvider = createProvider(providerType, providerOptions, ctx.runtime);
      const provider = rawProvider as StorageProvider;
      await provider.connect();

      const service = new StorageService(provider);
      ctx.services.register<IStorage>(CAPABILITIES.STORAGE, service);

      // M70c: reports BOTH signals. `isReady()` is lifecycle (never started /
      // shut down → `down`); `isHealthy()` is reachability (the backend answers
      // right now). A ready-but-unreachable provider is `down` with
      // `data.reachable: false` — the distinction an operator needs to tell
      // "we never started" from "the disk/bucket vanished under us". A provider
      // that cannot probe (gcs/azure client without the optional member) is
      // `up` with `data.reachable: 'unknown'`, honestly reporting "we did not
      // check".
      const storageIndicator = async (): Promise<HealthCheckResult> => {
        if (!provider.isReady()) {
          return { status: 'down', data: { provider: providerType, reachable: false } };
        }
        if (typeof provider.isHealthy !== 'function') {
          return { status: 'up', data: { provider: providerType, reachable: 'unknown' } };
        }
        const reachable = await provider.isHealthy();
        if (reachable === false) {
          return { status: 'down', data: { provider: providerType, reachable: false } };
        }
        return { status: 'up', data: { provider: providerType, reachable: true } };
      };
      ctx.health.register(CAPABILITIES.STORAGE, storageIndicator);

      ctx.lifecycle.onClose(async () => {
        await provider.disconnect();
      });
    },
  };
}
