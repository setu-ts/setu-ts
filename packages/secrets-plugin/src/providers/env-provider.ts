/**
 * EnvProvider — reads secrets from environment variables exposed through
 * `IRuntimeServices.env`. Zero-dependency and available on every runtime
 * (Node/Deno/Bun/Workers). Read-only: `set` throws.
 *
 * @module
 */
import type { SecretProvider } from '../interfaces/index.ts';

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
   * Always throws — environment variables are immutable at runtime.
   *
   * @param _name - Secret name (unused)
   * @param _value - New value (unused)
   * @throws {Error} Always, because `EnvProvider` is read-only
   */
  set(_name: string, _value: string): Promise<void> {
    return Promise.reject(
      new Error('EnvProvider is read-only; environment secrets cannot be rotated at runtime'),
    );
  }
}
