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
  IStorageDiagnosticsSource,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  createCachedProbe,
  PLUGIN_PRIORITY,
  resolveProbeTiming,
} from '@setu-ts/common';
import type { StoragePluginOptions, StorageProviderType } from '../interfaces/index.ts';
import type { StorageProvider } from '../interfaces/index.ts';
import {
  attachStorageCollector,
  detachStorageCollector,
  StorageService,
} from '../services/storage-service.ts';
import {
  compileStorageDiagnosticsAlias,
  createStorageDiagnosticsSource,
  StorageObservationCollector,
} from '../diagnostics/storage-observations.ts';
import { MemoryProvider } from '../providers/memory-provider.ts';
import { LocalStorageProvider } from '../providers/local-provider.ts';
import { S3Provider } from '../providers/s3-provider.ts';
import { GcsProvider } from '../providers/gcs-provider.ts';
import { AzureBlobProvider } from '../providers/azure-provider.ts';
import { VERSION } from '../version.ts';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'storage-plugin';

/** Default provider backend. */
const DEFAULT_PROVIDER: StorageProviderType = 'memory';

/** How long one reachability answer is reused, in milliseconds. */
const PROBE_TTL_MS = 5000;

/** Bound on one reachability probe, in milliseconds. */
const PROBE_TIMEOUT_MS = 2000;

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
  // The runtime's timers, for the cloud providers' `requestTimeoutMs` bound.
  // Resolved only by the arms that use it.
  const timing = (): ReturnType<typeof resolveProbeTiming> => resolveProbeTiming(runtime);

  switch (config.provider) {
    case undefined:
    case 'memory':
      return new MemoryProvider(now);

    case 'local':
      // `platform` is threaded in so a write-probe failure can name the Deno
      // flag that fixes it (X8-9) without this provider reaching a runtime API.
      return new LocalStorageProvider(runtime.fs, config.options, () => runtime.platform());

    case 's3': {
      const s3Opts = config.options;
      return new S3Provider(
        {
          region: s3Opts.region,
          bucket: s3Opts.bucket,
          accessKeyId: s3Opts.accessKeyId,
          secretAccessKey: s3Opts.secretAccessKey,
          endpoint: s3Opts.endpoint,
          requestTimeoutMs: s3Opts.requestTimeoutMs,
          client: s3Opts.client,
        },
        { name: 's3', timing: timing() },
      );
    }

    case 'b2': {
      // Backblaze B2: first-class S3-compatible preset.
      // Backblaze regions are named like `us-west-004`; there is no default
      // that is a real Backblaze host, so one of the two must be given.
      const b2Opts = config.options;
      if (
        b2Opts.region === undefined &&
        b2Opts.endpoint === undefined &&
        b2Opts.client === undefined
      ) {
        throw new Error(
          "storage-plugin: the 'b2' provider needs options.region (a Backblaze region such as " +
            "'us-west-004') or options.endpoint",
        );
      }
      const region = b2Opts.region;
      const endpoint =
        b2Opts.endpoint ??
        (region === undefined ? undefined : `https://s3.${region}.backblazeb2.com`);
      return new S3Provider(
        {
          region,
          bucket: b2Opts.bucket,
          accessKeyId: b2Opts.accessKeyId,
          secretAccessKey: b2Opts.secretAccessKey,
          endpoint,
          requestTimeoutMs: b2Opts.requestTimeoutMs,
          client: b2Opts.client,
        },
        { name: 'b2', timing: timing() },
      );
    }

    case 'gcs':
      return new GcsProvider(
        {
          projectId: config.options.projectId,
          bucket: config.options.bucket,
          endpoint: config.options.endpoint,
          endpointAuth: config.options.endpointAuth,
          requestTimeoutMs: config.options.requestTimeoutMs,
          client: config.options.client,
        },
        now,
        timing(),
      );

    case 'azure':
      return new AzureBlobProvider(
        {
          connectionString: config.options.connectionString,
          accountName: config.options.accountName,
          accountKey: config.options.accountKey,
          containerName: config.options.containerName,
          endpoint: config.options.endpoint,
          requestTimeoutMs: config.options.requestTimeoutMs,
          client: config.options.client,
        },
        now,
        timing(),
      );

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
  // M98m: validated here, before any application exists.
  const diagnosticsAlias =
    config.diagnostics === undefined ? null : compileStorageDiagnosticsAlias(config.diagnostics);

  return {
    name: PLUGIN_NAME,
    version: VERSION,
    optionalDependencies: ['logger', 'health'],
    provides: [CAPABILITIES.STORAGE],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const provider = createProvider(config, ctx.runtime);
      await provider.connect();

      const service = new StorageService(provider);
      ctx.services.register<IStorage>(CAPABILITIES.STORAGE, service);

      // M98m: EVERY instance contributes one storage-diagnostics source as a
      // multi provider (never claimed in `provides`, so multiple storage
      // instances never collide). It describes THIS service only — a later
      // replacement of the storage token is outside its coverage. Opted out,
      // the source is inert and nothing is attached to the service.
      const collector =
        diagnosticsAlias === null
          ? null
          : new StorageObservationCollector(diagnosticsAlias, ctx.runtime.hrtime.bind(ctx.runtime));
      if (collector !== null) {
        attachStorageCollector(service, collector);
      }
      ctx.services.register<IStorageDiagnosticsSource>(
        CAPABILITIES.STORAGE_DIAGNOSTICS,
        createStorageDiagnosticsSource(collector),
        { multi: true },
      );

      // M70c: reports BOTH signals. `isReady()` is lifecycle (never started /
      // shut down → `down`); `isHealthy()` is reachability (the backend answers
      // right now). A ready-but-unreachable provider is `down` with
      // `data.reachable: false` — the distinction an operator needs to tell
      // "we never started" from "the disk/bucket vanished under us". A provider
      // that cannot probe (gcs/azure client without the optional member) is
      // `up` with `data.reachable: 'unknown'`, honestly reporting "we did not
      // check". The probe is cached and bounded (5 s TTL, 2 s timeout, as in
      // secrets-plugin), so `/ready` is never held for a provider's
      // `requestTimeoutMs` and a burst of probes costs one backend call.
      const isHealthy = provider.isHealthy;
      const probe =
        typeof isHealthy === 'function'
          ? createCachedProbe({
              probe: () => isHealthy.call(provider),
              ttlMs: PROBE_TTL_MS,
              timeoutMs: PROBE_TIMEOUT_MS,
              ...resolveProbeTiming(ctx.runtime),
            })
          : undefined;
      const storageIndicator = async (): Promise<HealthCheckResult> => {
        if (!provider.isReady()) {
          return { status: 'down', data: { provider: providerType, reachable: false } };
        }
        if (probe === undefined) {
          return { status: 'up', data: { provider: providerType, reachable: 'unknown' } };
        }
        const reachable = await probe();
        if (reachable === false) {
          return { status: 'down', data: { provider: providerType, reachable: false } };
        }
        return { status: 'up', data: { provider: providerType, reachable: true } };
      };
      ctx.health.register(CAPABILITIES.STORAGE, storageIndicator);

      ctx.lifecycle.onClose(async () => {
        // Detach first so no late call is observed, then clear, BEFORE the
        // provider disconnect: a failed disconnect must not leave a live
        // collector attached to a half-closed service.
        detachStorageCollector(service);
        collector?.close();
        await provider.disconnect();
      });
    },
  };
}
