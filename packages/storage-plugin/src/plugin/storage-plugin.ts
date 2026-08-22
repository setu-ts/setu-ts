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
import type { StoragePluginOptions, StorageProviderType } from '../interfaces/index.ts';
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
 * Takes the whole discriminated {@linkcode StoragePluginOptions} rather than a
 * loose `(type, options)` pair, so each arm reads its own option shape directly
 * — the five `options as XProviderOptions` casts this used to carry existed
 * only because the union could not be narrowed.
 *
 * @param config - The plugin configuration, narrowed per arm
 * @param runtime - The runtime environment services (for `LocalStorageProvider`)
 * @returns The provider adapter
 * @throws {Error} If the provider type is unsupported
 */
export function createProvider(
  config: StoragePluginOptions,
  runtime: IRuntimeServices,
): StorageProvider {
  // Wall-clock source for providers that compute signed-URL expiry. `runtime.now()`
  // is the only sanctioned clock outside `packages/runtime` (no direct platform clock).
  const now = (): number => runtime.now();

  switch (config.provider) {
    case undefined:
    case 'memory':
      return new MemoryProvider(now);

    case 'local':
      return new LocalStorageProvider(runtime.fs, config.options);

    case 's3': {
      const s3Opts = config.options;
      return new S3Provider({
        region: s3Opts.region,
        bucket: s3Opts.bucket,
        accessKeyId: s3Opts.accessKeyId,
        secretAccessKey: s3Opts.secretAccessKey,
        endpoint: s3Opts.endpoint,
        client: s3Opts.client,
      });
    }

    case 'b2': {
      // Backblaze B2: first-class S3-compatible preset.
      const b2Opts = config.options;
      const region = b2Opts.region ?? 'us-east-1';
      const endpoint = b2Opts.endpoint ?? `https://s3.${region}.backblazeb2.com`;
      return new S3Provider({
        region,
        bucket: b2Opts.bucket,
        accessKeyId: b2Opts.accessKeyId,
        secretAccessKey: b2Opts.secretAccessKey,
        endpoint,
        client: b2Opts.client,
      });
    }

    case 'gcs':
      return new GcsProvider({
        projectId: config.options.projectId,
        bucket: config.options.bucket,
        client: config.options.client,
      }, now);

    case 'azure':
      return new AzureBlobProvider({
        connectionString: config.options.connectionString,
        accountName: config.options.accountName,
        accountKey: config.options.accountKey,
        containerName: config.options.containerName,
        client: config.options.client,
      }, now);

    default: {
      // Unreachable through the typed surface; reached only when a JavaScript
      // caller passes a provider name the union does not carry.
      const unknownProvider: string = (config as { provider: string }).provider;
      throw new Error(`Unsupported storage provider: ${unknownProvider}`);
    }
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
  const config: StoragePluginOptions = options ?? {};
  const providerType = config.provider ?? DEFAULT_PROVIDER;

  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    optionalDependencies: ['logger', 'health'],
    provides: [CAPABILITIES.STORAGE],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const provider = createProvider(config, ctx.runtime);
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
