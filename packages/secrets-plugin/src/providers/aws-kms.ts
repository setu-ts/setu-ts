/**
 * AwsKmsProvider — retrieves and rotates named secrets in AWS Secrets Manager
 * (which encrypts values with AWS KMS). The `@aws-sdk/client-secrets-manager`
 * SDK is never a hard dependency: inject an {@linkcode IAwsSecretsClient}
 * facade, or the provider lazily imports and adapts the SDK.
 *
 * @module
 */
import type { DeadlineOptions } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { IAwsSecretsClient, SecretProvider } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';
import type { SecretsDeadline } from './bounded-call.ts';
import {
  answered,
  resolveSecretsDeadline,
  runSecretsCall,
  toSecretsError,
} from './bounded-call.ts';

/** Provider name carried on its errors. */
const PROVIDER_NAME = 'AwsKmsProvider';

/** Methods an injected AWS client facade must expose. */
const REQUIRED_METHODS = ['getSecretValue', 'putSecretValue'] as const;

/** AWS error name signalling an absent secret. */
const NOT_FOUND = 'ResourceNotFoundException';

/** The subset of the AWS SDK the adapter uses. */
export interface AwsSdkModule {
  SecretsManagerClient: new (config: Record<string, unknown>) => {
    send(
      command: unknown,
      options?: { abortSignal?: AbortSignal },
    ): Promise<{ SecretString?: string | undefined }>;
  };
  GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
  PutSecretValueCommand: new (input: { SecretId: string; SecretString: string }) => unknown;
  ListSecretsCommand: new (input: { MaxResults: number }) => unknown;
}

/**
 * Options for {@linkcode AwsKmsProvider}.
 *
 * @since 0.1.0
 */
export interface AwsKmsProviderOptions {
  /** AWS region for the lazily-loaded client. */
  region?: string | undefined;
  /** AWS access key id for the lazily-loaded client. */
  accessKeyId?: string | undefined;
  /** AWS secret access key for the lazily-loaded client. */
  secretAccessKey?: string | undefined;
  /**
   * Endpoint for the lazily-loaded client — LocalStack, an emulator, or a
   * private endpoint. Ignored when a `client` is injected, matching `region`.
   *
   * @since 0.8.0
   */
  endpoint?: string | undefined;
  /**
   * Bound on each Secrets Manager call, in milliseconds, including the SDK's
   * own retries. A call that fails on the network, gets a `5xx`, or does not
   * answer in time rejects with `SecretProviderUnavailableError` (`503`). `0`
   * disables the bound; anything outside `0`–`2147483647` throws `RangeError`
   * at construction.
   *
   * @default 5000
   * @since 0.14.0
   */
  requestTimeoutMs?: number | undefined;
  /**
   * Timer surface the bound runs on. `SecretsPlugin` supplies the runtime's
   * timers; a directly constructed provider falls back to the ambient ones.
   *
   * @since 0.14.0
   */
  timing?: DeadlineOptions['timing'];
  /** Injected client facade; bypasses the lazy SDK import. */
  client?: IAwsSecretsClient | undefined;
}

/**
 * Validates that an injected object matches {@linkcode IAwsSecretsClient}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 */
export function validateAwsClient(client: unknown): client is IAwsSecretsClient {
  return hasMethods(client, REQUIRED_METHODS);
}

/**
 * Adapts the AWS SDK module to the facade. Pure — unit-tested with a fake
 * module; the real module is supplied on the lazy path by {@linkcode loadAwsModule}.
 *
 * @param mod - The AWS SDK module (real or fake)
 * @param options - AWS connection options
 * @returns The facade wrapping a `SecretsManagerClient`
 */
export function adaptAwsModule(
  mod: AwsSdkModule,
  options: AwsKmsProviderOptions,
  deadline: SecretsDeadline = resolveSecretsDeadline(options.requestTimeoutMs, options.timing),
): IAwsSecretsClient {
  const client = new mod.SecretsManagerClient(
    buildAwsConfig(options.region, options.accessKeyId, options.secretAccessKey, options.endpoint),
  );
  // Every SDK call runs under the bound and receives its signal, so an expired
  // bound also aborts the request the SDK holds.
  const send = (command: unknown): Promise<{ SecretString?: string | undefined }> =>
    runSecretsCall(deadline, PROVIDER_NAME, (abortSignal) => client.send(command, { abortSignal }));
  return {
    async getSecretValue(secretId: string): Promise<string | null> {
      try {
        const res = await send(new mod.GetSecretValueCommand({ SecretId: secretId }));
        return res.SecretString ?? null;
      } catch (error) {
        if (error instanceof Error && error.name === NOT_FOUND) {
          return null;
        }
        throw error;
      }
    },
    async putSecretValue(secretId: string, value: string): Promise<void> {
      await send(new mod.PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
    },
    // Non-mutating: lists at most one secret's metadata, never a value.
    isHealthy(): Promise<boolean> {
      return answered(() => send(new mod.ListSecretsCommand({ MaxResults: 1 })));
    },
  };
}

/**
 * Lazily imports the AWS Secrets Manager SDK. Only exercised on the lazy path.
 *
 * @returns The SDK module
 * @throws {Error} If `@aws-sdk/client-secrets-manager` cannot be resolved
 */
export async function loadAwsModule(): Promise<AwsSdkModule> {
  try {
    return (await import('@aws-sdk/client-secrets-manager')) as unknown as AwsSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@aws-sdk/client-secrets-manager', {
      requiredBy: '@setu-ts/secrets-plugin',
      cause: error,
    });
  }
}

/**
 * Builds a `SecretsManagerClient` config without assigning `undefined` to
 * optional fields (required by `exactOptionalPropertyTypes`).
 */
function buildAwsConfig(
  region?: string,
  accessKeyId?: string,
  secretAccessKey?: string,
  endpoint?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (region !== undefined) {
    config.region = region;
  }
  if (accessKeyId !== undefined && secretAccessKey !== undefined) {
    config.credentials = { accessKeyId, secretAccessKey };
  }
  if (endpoint !== undefined) {
    config.endpoint = endpoint;
  }
  return config;
}

/**
 * AWS Secrets Manager provider.
 *
 * @since 0.1.0
 */
export class AwsKmsProvider implements SecretProvider {
  #client: IAwsSecretsClient | null = null;
  /** `true` when the client was injected: its calls are bounded here, by race. */
  #injected = false;
  readonly #options: AwsKmsProviderOptions;
  readonly #deadline: SecretsDeadline;
  /**
   * Reachability probe. The lazily adapted client lists at most one secret's
   * metadata (`ListSecrets`, non-mutating) and reads reachable when Secrets
   * Manager answers at all; an injected facade publishes its own `isHealthy`
   * when it has one, and the indicator reports `reachable: 'unknown'` when it
   * does not.
   *
   * @since 0.5.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param options - AWS connection/injection options
   * @throws {RangeError} When `requestTimeoutMs` is out of range
   */
  constructor(options?: AwsKmsProviderOptions) {
    this.#options = options ?? {};
    this.#deadline = resolveSecretsDeadline(this.#options.requestTimeoutMs, this.#options.timing);
  }

  async connect(): Promise<void> {
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateAwsClient(injected)) {
        throw new Error(
          'Injected AWS client is missing required methods (getSecretValue, putSecretValue)',
        );
      }
      this.#client = injected;
      this.#injected = true;
    } else {
      this.#client = adaptAwsModule(await loadAwsModule(), this.#options, this.#deadline);
      this.#injected = false;
    }
    this.#attachProbe(this.#client);
  }

  disconnect(): Promise<void> {
    this.#client = null;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#client !== null;
  }

  /**
   * Exposes the client's optional probe, called through its OWNER so a facade
   * reading instance state still resolves.
   *
   * @param client - The resolved client
   */
  #attachProbe(client: IAwsSecretsClient): void {
    // Captured into a local before the guard so the closure keeps the
    // narrowed function type and still calls through the owner.
    const probe = client.isHealthy;
    if (typeof probe === 'function') {
      this.isHealthy = (): Promise<boolean> => probe.call(client);
    }
  }

  /** Runs one client call, bounded here for an injected client, and classifies it. */
  async #call<T>(operation: string, run: (client: IAwsSecretsClient) => Promise<T>): Promise<T> {
    const client = this.#client;
    if (client === null) throw new Error('AwsKmsProvider is not connected');
    try {
      return this.#injected
        ? await runSecretsCall(this.#deadline, PROVIDER_NAME, () => run(client))
        : await run(client);
    } catch (error) {
      throw toSecretsError(error, PROVIDER_NAME, operation);
    }
  }

  /**
   * Reads a secret from AWS Secrets Manager.
   *
   * @param name - The secret id
   * @returns The value, or `null` when absent
   * @throws {SecretProviderUnavailableError} When Secrets Manager cannot be
   *   reached or does not answer within `requestTimeoutMs`
   */
  get(name: string): Promise<string | null> {
    return this.#call('get', (client) => client.getSecretValue(name));
  }

  /**
   * Writes a new value for a secret.
   *
   * @param name - The secret id
   * @param value - The new value
   * @throws {SecretProviderUnavailableError} When Secrets Manager cannot be
   *   reached or does not answer within `requestTimeoutMs`
   */
  set(name: string, value: string): Promise<void> {
    return this.#call('set', (client) => client.putSecretValue(name, value));
  }
}
