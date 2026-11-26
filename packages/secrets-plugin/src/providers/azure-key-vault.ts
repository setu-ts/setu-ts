/**
 * AzureKeyVaultProvider — retrieves and rotates secrets in Azure Key Vault.
 * The `@azure/keyvault-secrets` / `@azure/identity` SDKs are never hard
 * dependencies: inject an {@linkcode IAzureSecretsClient} facade, or the
 * provider lazily imports and adapts the SDK.
 *
 * @module
 */
import type { DeadlineOptions } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { IAzureSecretsClient, SecretProvider } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';
import type { SecretsDeadline } from './bounded-call.ts';
import {
  answered,
  resolveSecretsDeadline,
  runSecretsCall,
  toSecretsError,
} from './bounded-call.ts';

/** Provider name carried on its errors. */
const PROVIDER_NAME = 'AzureKeyVaultProvider';

/** Methods an injected Azure client facade must expose. */
const REQUIRED_METHODS = ['getSecret', 'setSecret'] as const;

/** HTTP status signalling an absent secret. */
const HTTP_NOT_FOUND = 404;

/** A minimal token credential. */
type AzureCredential = object;

/** The subset of the Azure SDKs the adapter uses. */
export interface AzureSdkModule {
  SecretClient: new (
    vaultUrl: string,
    credential: AzureCredential,
    options?: { disableChallengeResourceVerification?: boolean },
  ) => {
    getSecret(name: string, options?: AzureCallOptions): Promise<{ value?: string | undefined }>;
    setSecret(name: string, value: string, options?: AzureCallOptions): Promise<unknown>;
    listPropertiesOfSecrets(options?: AzureCallOptions): {
      byPage(settings: { maxPageSize: number }): { next(): Promise<unknown> };
    };
  };
  DefaultAzureCredential: new () => AzureCredential;
}

/** Options each bounded Key Vault call takes. */
export interface AzureCallOptions {
  abortSignal?: AbortSignal;
}

/**
 * Options for {@linkcode AzureKeyVaultProvider}.
 *
 * @since 0.1.0
 */
export interface AzureKeyVaultProviderOptions {
  /** Key Vault URL for the lazily-loaded client. */
  vaultUrl?: string | undefined;
  /**
   * Passed to the SDK's `SecretClient`. The SDK checks that the vault's
   * authentication challenge names the vault's own domain, so a bearer token is
   * never sent to a host that is not the vault; that check refuses a vault at
   * `localhost`. Set `true` only for an emulator or a test vault.
   *
   * @default false
   * @since 0.14.0
   */
  disableChallengeResourceVerification?: boolean | undefined;
  /**
   * Bound on each Key Vault call, in milliseconds, including the SDK's own
   * retries. A call that fails on the network, gets a `5xx`, or does not
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
  client?: IAzureSecretsClient | undefined;
}

/**
 * Validates that an injected object matches {@linkcode IAzureSecretsClient}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 */
export function validateAzureClient(client: unknown): client is IAzureSecretsClient {
  return hasMethods(client, REQUIRED_METHODS);
}

/** Reports whether a caught error is an HTTP 404. */
export function isAzureNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { statusCode?: unknown }).statusCode === HTTP_NOT_FOUND
  );
}

/**
 * Adapts the Azure SDK modules to the facade. Pure — unit-tested with a fake
 * module; the real modules are supplied on the lazy path by
 * {@linkcode loadAzureModule}.
 *
 * @param mod - The combined Azure SDK surface (real or fake)
 * @param options - Key Vault options
 * @param deadline - The bound on each call
 * @returns The facade wrapping a `SecretClient`
 * @throws {Error} When `options.vaultUrl` is missing
 */
export function adaptAzureModule(
  mod: AzureSdkModule,
  options: AzureKeyVaultProviderOptions,
  deadline: SecretsDeadline = resolveSecretsDeadline(options.requestTimeoutMs, options.timing),
): IAzureSecretsClient {
  const vaultUrl = options.vaultUrl;
  if (vaultUrl === undefined || vaultUrl === '') {
    throw new Error('AzureKeyVaultProvider requires options.vaultUrl');
  }
  const client = new mod.SecretClient(
    vaultUrl,
    new mod.DefaultAzureCredential(),
    options.disableChallengeResourceVerification === true
      ? { disableChallengeResourceVerification: true }
      : {},
  );
  // Every SDK call runs under the bound and receives its signal.
  const bounded = <T>(run: (abortSignal: AbortSignal) => Promise<T>): Promise<T> =>
    runSecretsCall(deadline, PROVIDER_NAME, run);
  return {
    async getSecret(name: string): Promise<string | null> {
      try {
        const secret = await bounded((abortSignal) => client.getSecret(name, { abortSignal }));
        return secret.value ?? null;
      } catch (error) {
        if (isAzureNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    async setSecret(name: string, value: string): Promise<void> {
      await bounded((abortSignal) => client.setSecret(name, value, { abortSignal }));
    },
    // Non-mutating: lists at most one secret's properties, never a value.
    isHealthy(): Promise<boolean> {
      return answered(() =>
        bounded((abortSignal) =>
          client.listPropertiesOfSecrets({ abortSignal }).byPage({ maxPageSize: 1 }).next(),
        ),
      );
    },
  };
}

/**
 * Lazily imports the Azure Key Vault + Identity SDKs. Only exercised on the
 * lazy path.
 *
 * @returns The combined SDK module
 * @throws {Error} If the packages cannot be resolved
 */
export async function loadAzureModule(): Promise<AzureSdkModule> {
  // Two guards, one per import, so the error names the package that actually
  // failed rather than sniffing a rejection message (M113d §3.1).
  let secretsMod: typeof import('@azure/keyvault-secrets');
  try {
    secretsMod = await import('@azure/keyvault-secrets');
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@azure/keyvault-secrets', {
      requiredBy: '@setu-ts/secrets-plugin',
      cause: error,
    });
  }
  let identityMod: typeof import('@azure/identity');
  try {
    identityMod = await import('@azure/identity');
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@azure/identity', {
      requiredBy: '@setu-ts/secrets-plugin',
      cause: error,
    });
  }
  return {
    SecretClient: secretsMod.SecretClient,
    DefaultAzureCredential: identityMod.DefaultAzureCredential,
  } as unknown as AzureSdkModule;
}

/**
 * Azure Key Vault provider.
 *
 * @since 0.1.0
 */
export class AzureKeyVaultProvider implements SecretProvider {
  #client: IAzureSecretsClient | null = null;
  /** `true` when the client was injected: its calls are bounded here, by race. */
  #injected = false;
  readonly #options: AzureKeyVaultProviderOptions;
  readonly #deadline: SecretsDeadline;
  /**
   * Reachability probe. The lazily adapted client lists at most one secret's
   * properties (non-mutating) and reads reachable when Key Vault answers at
   * all; an injected facade publishes its own `isHealthy` when it has one, and
   * the indicator reports `reachable: 'unknown'` when it does not.
   *
   * @since 0.5.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param options - Key Vault connection/injection options
   * @throws {RangeError} When `requestTimeoutMs` is out of range
   */
  constructor(options?: AzureKeyVaultProviderOptions) {
    this.#options = options ?? {};
    this.#deadline = resolveSecretsDeadline(this.#options.requestTimeoutMs, this.#options.timing);
  }

  async connect(): Promise<void> {
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateAzureClient(injected)) {
        throw new Error('Injected Azure client is missing required methods (getSecret, setSecret)');
      }
      this.#client = injected;
      this.#injected = true;
    } else {
      this.#client = adaptAzureModule(await loadAzureModule(), this.#options, this.#deadline);
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
  #attachProbe(client: IAzureSecretsClient): void {
    // Captured into a local before the guard so the closure keeps the
    // narrowed function type and still calls through the owner.
    const probe = client.isHealthy;
    if (typeof probe === 'function') {
      this.isHealthy = (): Promise<boolean> => probe.call(client);
    }
  }

  /** Runs one client call, bounded here for an injected client, and classifies it. */
  async #call<T>(operation: string, run: (client: IAzureSecretsClient) => Promise<T>): Promise<T> {
    const client = this.#client;
    if (client === null) throw new Error('AzureKeyVaultProvider is not connected');
    try {
      return this.#injected
        ? await runSecretsCall(this.#deadline, PROVIDER_NAME, () => run(client))
        : await run(client);
    } catch (error) {
      throw toSecretsError(error, PROVIDER_NAME, operation);
    }
  }

  /**
   * Reads a secret's current value.
   *
   * @param name - The secret name
   * @returns The value, or `null` when absent
   * @throws {SecretProviderUnavailableError} When Key Vault cannot be reached or
   *   does not answer within `requestTimeoutMs`
   */
  get(name: string): Promise<string | null> {
    return this.#call('get', (client) => client.getSecret(name));
  }

  /**
   * Sets a secret's value (creating it when absent).
   *
   * @param name - The secret name
   * @param value - The new value
   * @throws {SecretProviderUnavailableError} When Key Vault cannot be reached or
   *   does not answer within `requestTimeoutMs`
   */
  set(name: string, value: string): Promise<void> {
    return this.#call('set', (client) => client.setSecret(name, value));
  }
}
