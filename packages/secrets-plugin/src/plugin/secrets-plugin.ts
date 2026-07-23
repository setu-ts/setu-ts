/**
 * SecretsPlugin — registers an {@linkcode ISecretManager} under
 * `CAPABILITIES.SECRETS`, backed by a pluggable provider.
 *
 * @module
 */
import type {
  ILogger,
  IPlugin,
  IPluginContext,
  IRuntimeServices,
  ISecretManager,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type {
  IAwsSecretsClient,
  IAzureSecretsClient,
  IGcpSecretsClient,
  SecretProvider,
  SecretsPluginOptions,
  SecretsProviderOptions,
  SecretsProviderType,
} from '../interfaces/index.ts';
import { SecretsService } from '../services/secrets-service.ts';
import { EnvProvider } from '../providers/env-provider.ts';
import { AwsKmsProvider } from '../providers/aws-kms.ts';
import { GcpSecretManagerProvider } from '../providers/gcp-secret-manager.ts';
import { AzureKeyVaultProvider } from '../providers/azure-key-vault.ts';
import { HashiCorpVaultProvider } from '../providers/vault.ts';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'secrets-plugin';

/** Default provider backend. */
const DEFAULT_PROVIDER: SecretsProviderType = 'env';

/**
 * Builds the provider adapter for the configured backend.
 *
 * @param type - The provider backend id
 * @param options - Provider-specific options
 * @param env - The runtime environment map (for `EnvProvider`)
 * @returns The provider adapter
 * @throws {Error} If the provider type is unsupported
 */
export function createProvider(
  type: SecretsProviderType,
  options: SecretsProviderOptions,
  env: Readonly<Record<string, string | undefined>>,
): SecretProvider {
  switch (type) {
    case 'aws-kms':
      return new AwsKmsProvider({
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        client: isAwsClient(options.client) ? options.client : undefined,
      });
    case 'gcp':
      return new GcpSecretManagerProvider({
        projectId: options.projectId,
        client: isGcpClient(options.client) ? options.client : undefined,
      });
    case 'azure':
      return new AzureKeyVaultProvider({
        vaultUrl: options.vaultUrl,
        client: isAzureClient(options.client) ? options.client : undefined,
      });
    case 'vault':
      return new HashiCorpVaultProvider({
        address: options.address,
        token: options.token,
        mount: options.mount,
        http: options.http,
      });
    case 'env':
      return new EnvProvider(env, { prefix: options.prefix });
    default:
      throw new Error(`Unsupported secrets provider: ${type as string}`);
  }
}

/**
 * Creates the SecretsPlugin.
 *
 * Registers an {@linkcode ISecretManager} under `CAPABILITIES.SECRETS`. The
 * default provider is `'env'` (zero dependency, every runtime).
 *
 * @example
 * ```typescript
 * import { SecretsPlugin } from '@hono-enterprise/secrets-plugin';
 *
 * // Environment variables (default)
 * app.register(SecretsPlugin());
 *
 * // HashiCorp Vault
 * app.register(SecretsPlugin({
 *   provider: 'vault',
 *   options: { address: 'https://vault.example.com', token: vaultToken },
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function SecretsPlugin(options?: SecretsPluginOptions): IPlugin {
  const providerType = options?.provider ?? DEFAULT_PROVIDER;
  const providerOptions = options?.options ?? {};

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    optionalDependencies: ['logger'],
    provides: [CAPABILITIES.SECRETS],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const provider = createProvider(providerType, providerOptions, ctx.runtime.env);
      await provider.connect();

      const service = new SecretsService(provider, buildServiceOptions(providerOptions, ctx));
      ctx.services.register<ISecretManager>(CAPABILITIES.SECRETS, service);

      const logger = resolveLogger(ctx);
      // Log metadata only — never a secret value (AI_GUIDELINES §13.3).
      logger?.debug('SecretsPlugin registered', { provider: providerType });

      ctx.health.register(CAPABILITIES.SECRETS, () =>
        Promise.resolve({
          status: provider.isReady() ? 'up' : 'down',
          data: { provider: providerType },
        }));

      ctx.lifecycle.onClose(async () => {
        await provider.disconnect();
      });
    },
  };
}

/**
 * Builds {@linkcode SecretsService} options without assigning `undefined` to
 * optional fields (required by `exactOptionalPropertyTypes`).
 */
function buildServiceOptions(
  options: SecretsProviderOptions,
  ctx: IPluginContext,
): { cacheTtlSeconds?: number; clock?: () => number } {
  const result: { cacheTtlSeconds?: number; clock?: () => number } = {};
  if (options.cacheTtl !== undefined) {
    result.cacheTtlSeconds = options.cacheTtl;
  }
  const clock = resolveClock(ctx);
  if (clock !== undefined) {
    result.clock = clock;
  }
  return result;
}

/** Resolves a monotonic clock from the runtime service when available. */
function resolveClock(ctx: IPluginContext): (() => number) | undefined {
  if (ctx.services.has(CAPABILITIES.RUNTIME)) {
    const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    return runtime.hrtime.bind(runtime);
  }
  return undefined;
}

/** Resolves an optional logger from the plugin context. */
function resolveLogger(ctx: IPluginContext): ILogger | undefined {
  if (ctx.services.has(CAPABILITIES.LOGGER)) {
    return ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  }
  return undefined;
}

/** Narrows an injected client to the AWS facade by structural probe. */
function isAwsClient(client: SecretsProviderOptions['client']): client is IAwsSecretsClient {
  return client !== undefined && 'getSecretValue' in client;
}

/** Narrows an injected client to the GCP facade by structural probe. */
function isGcpClient(client: SecretsProviderOptions['client']): client is IGcpSecretsClient {
  return client !== undefined && 'accessSecretVersion' in client;
}

/** Narrows an injected client to the Azure facade by structural probe. */
function isAzureClient(client: SecretsProviderOptions['client']): client is IAzureSecretsClient {
  return client !== undefined && 'getSecret' in client;
}
