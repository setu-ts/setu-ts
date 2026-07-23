/**
 * AwsKmsProvider — retrieves and rotates named secrets in AWS Secrets Manager
 * (which encrypts values with AWS KMS). The `@aws-sdk/client-secrets-manager`
 * SDK is never a hard dependency: inject an {@linkcode IAwsSecretsClient}
 * facade, or the provider lazily imports and adapts the SDK.
 *
 * @module
 */
import type { IAwsSecretsClient, SecretProvider } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';

/** Methods an injected AWS client facade must expose. */
const REQUIRED_METHODS = ['getSecretValue', 'putSecretValue'] as const;

/** AWS error name signalling an absent secret. */
const NOT_FOUND = 'ResourceNotFoundException';

/** The subset of the AWS SDK the adapter uses. */
export interface AwsSdkModule {
  SecretsManagerClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<{ SecretString?: string | undefined }>;
  };
  GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
  PutSecretValueCommand: new (input: { SecretId: string; SecretString: string }) => unknown;
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
): IAwsSecretsClient {
  const client = new mod.SecretsManagerClient(
    buildAwsConfig(options.region, options.accessKeyId, options.secretAccessKey),
  );
  return {
    async getSecretValue(secretId: string): Promise<string | null> {
      try {
        const res = await client.send(new mod.GetSecretValueCommand({ SecretId: secretId }));
        return res.SecretString ?? null;
      } catch (error) {
        if (error instanceof Error && error.name === NOT_FOUND) {
          return null;
        }
        throw error;
      }
    },
    async putSecretValue(secretId: string, value: string): Promise<void> {
      await client.send(new mod.PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
    },
  };
}

/**
 * Lazily imports the AWS Secrets Manager SDK. Only exercised on the lazy path.
 *
 * @returns The SDK module
 * @throws {Error} If `npm:@aws-sdk/client-secrets-manager` cannot be resolved
 */
export async function loadAwsModule(): Promise<AwsSdkModule> {
  return await import('npm:@aws-sdk/client-secrets-manager@^3') as unknown as AwsSdkModule;
}

/**
 * Builds a `SecretsManagerClient` config without assigning `undefined` to
 * optional fields (required by `exactOptionalPropertyTypes`).
 */
function buildAwsConfig(
  region?: string,
  accessKeyId?: string,
  secretAccessKey?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (region !== undefined) {
    config.region = region;
  }
  if (accessKeyId !== undefined && secretAccessKey !== undefined) {
    config.credentials = { accessKeyId, secretAccessKey };
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
  readonly #options: AwsKmsProviderOptions;

  /**
   * @param options - AWS connection/injection options
   */
  constructor(options?: AwsKmsProviderOptions) {
    this.#options = options ?? {};
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
      return;
    }
    this.#client = adaptAwsModule(await loadAwsModule(), this.#options);
  }

  disconnect(): Promise<void> {
    this.#client = null;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#client !== null;
  }

  /**
   * Reads a secret from AWS Secrets Manager.
   *
   * @param name - The secret id
   * @returns The value, or `null` when absent
   */
  get(name: string): Promise<string | null> {
    if (this.#client === null) {
      return Promise.reject(new Error('AwsKmsProvider is not connected'));
    }
    return this.#client.getSecretValue(name);
  }

  /**
   * Writes a new value for a secret.
   *
   * @param name - The secret id
   * @param value - The new value
   */
  set(name: string, value: string): Promise<void> {
    if (this.#client === null) {
      return Promise.reject(new Error('AwsKmsProvider is not connected'));
    }
    return this.#client.putSecretValue(name, value);
  }
}
