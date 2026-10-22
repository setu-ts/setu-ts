/**
 * EnvProvider — reads secrets from environment variables exposed through
 * `IRuntimeServices.env`, then an optional config snapshot for missing keys.
 * Only strings are returned. Zero-dependency and available on every runtime
 * (Node/Deno/Bun/Workers). Read-only: `set` rejects with
 * {@linkcode ReadOnlySecretProviderError}, branded `501` (X20-2, M90f).
 *
 * @module
 */
import type { IConfig } from '@setu-ts/common';
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
 * Environment-first secret provider with an optional config fallback.
 *
 * @since 0.1.0
 */
export class EnvProvider implements SecretProvider {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #prefix: string;
  readonly #config: Pick<IConfig, 'get'> | undefined;

  /**
   * @param env - The runtime environment map (`IRuntimeServices.env`)
   * @param options - Provider options
   * @param options.prefix - Prefix prepended to the derived env key
   * @param options.config - Config snapshot consulted only when env lacks a string value
   */
  constructor(
    env: Readonly<Record<string, string | undefined>>,
    options?: { prefix?: string | undefined; config?: Pick<IConfig, 'get'> },
  ) {
    this.#env = env;
    this.#prefix = options?.prefix ?? '';
    this.#config = options?.config;
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
   * Reads the derived key from the environment first, then config. Environment
   * strings are returned unchanged, including empty strings and `${NAME}`
   * references. Config values must be strings; no coercion is performed.
   *
   * @param name - Secret name/path
   * @returns The string value, or `null` when neither source supplies a string
   */
  get(name: string): Promise<string | null> {
    const key = toEnvKey(name, this.#prefix);
    const value = this.#env[key];
    if (typeof value === 'string') {
      return Promise.resolve(value);
    }
    // A replacement `IConfig` may throw; surface that as a rejection so a
    // `.catch()` caller sees it, matching the method's Promise contract.
    let fallback: unknown;
    try {
      fallback = this.#config?.get<unknown>(key);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(typeof fallback === 'string' ? fallback : null);
  }

  /**
   * Always rejects — this provider is read-only.
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
