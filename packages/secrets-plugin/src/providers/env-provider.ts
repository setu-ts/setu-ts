/**
 * EnvProvider — reads secrets from environment variables exposed through
 * `IRuntimeServices.env`. Zero-dependency and available on every runtime
 * (Node/Deno/Bun/Workers). Read-only: `set` rejects with
 * {@linkcode ReadOnlySecretProviderError}, branded `501` (X20-2, M90f).
 *
 * @module
 */
import type { SecretProvider } from '../interfaces/index.ts';
import { ReadOnlySecretProviderError } from '../errors.ts';

/**
 * Maps a secret name/path to an environment-variable key: prepends the prefix,
 * uppercases, and replaces `/`, `-`, and `.` with `_`.
 *
 * @param name - Secret name/path (e.g. `database/password`)
 * @param prefix - Optional prefix (e.g. `APP_`)
 * @returns The derived env key (e.g. `APP_DATABASE_PASSWORD`)
 */
export function toEnvKey(name: string, prefix: string): string {
  return `${prefix}${name}`.toUpperCase().replace(/[/.-]/g, '_');
}

/**
 * Environment-variable secret provider.
 *
 * @since 0.1.0
 */
export class EnvProvider implements SecretProvider {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #prefix: string;

  /**
   * @param env - The runtime environment map (`IRuntimeServices.env`)
   * @param options - Provider options
   * @param options.prefix - Prefix prepended to the derived env key
   */
  constructor(
    env: Readonly<Record<string, string | undefined>>,
    options?: { prefix?: string | undefined },
  ) {
    this.#env = env;
    this.#prefix = options?.prefix ?? '';
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  isReady(): boolean {
    return true;
  }

  /**
   * Lifecycle truth (M90b): environment variables are process state, so the
   * only honest reachability answer is readiness.
   *
   * @returns `true` — the environment is always reachable
   * @since 0.5.0
   */
  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.isReady());
  }

  /**
   * Reads the environment variable for a secret name.
   *
   * @param name - Secret name/path
   * @returns The value, or `null` when the variable is unset
   */
  get(name: string): Promise<string | null> {
    const value = this.#env[toEnvKey(name, this.#prefix)];
    return Promise.resolve(value ?? null);
  }

  /**
   * Always rejects — environment variables are immutable at runtime.
   *
   * The rejection is branded with a `501` HTTP status hint (X20-2, M90f), so
   * an application running `errorHandler` answers the write attempt with
   * `501 Not Implemented` in its configured format rather than the masked
   * `500` an unbranded rejection from this depth would produce. It
   * REJECTS — never throws synchronously — so a caller using `.catch()`
   * observes it either way.
   *
   * `SecretsService.rotate()` reaches this same site by delegating to `set`,
   * which is what makes both public write operations answer identically.
   *
   * @param _name - Secret name (unused)
   * @param _value - New value (unused)
   * @returns A rejected promise carrying {@linkcode ReadOnlySecretProviderError}
   */
  set(_name: string, _value: string): Promise<void> {
    return Promise.reject(new ReadOnlySecretProviderError('EnvProvider'));
  }
}
