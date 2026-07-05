/**
 * ConfigService — immutable configuration snapshot implementing {@linkcode IConfig}.
 *
 * The configuration is an immutable application-startup snapshot: values are
 * loaded once at startup and never mutated. This fulfills caching requirements
 * without a mutable cache API.
 *
 * @module
 */
import type { IConfig } from '@hono-enterprise/common';

/**
 * Internal configuration service implementing the {@linkcode IConfig} contract.
 *
 * Values are stored in a plain record and treated as immutable after
 * construction. `has()` and `getOrThrow()` treat `undefined` as absent.
 *
 * @since 0.1.0
 */
export class ConfigService implements IConfig {
  /**
   * Creates an immutable configuration service from the provided data.
   *
   * The data is shallow-copied so that mutations to the original object
   * do not affect the configuration snapshot.
   *
   * @param data - The configuration key-value pairs
   */
  constructor(data: Readonly<Record<string, unknown>>) {
    this.data = { ...data };
  }

  private readonly data: Readonly<Record<string, unknown>>;

  /**
   * Reads a configuration value.
   *
   * When called with only a key, returns the value or `undefined` if absent.
   * When called with a default option, returns the value or the default.
   *
   * @typeParam T - The expected value type
   * @param key - Configuration key
   * @param options - Optional default value
   * @returns The value, `undefined`, or the default
   */
  get<T>(key: string): T | undefined;
  get<T>(key: string, options: { readonly default: T }): T;
  get<T>(key: string, options?: { readonly default?: T }): T | undefined {
    const value = this.data[key];

    if (value === undefined) {
      return options?.default ?? undefined;
    }

    return value as T;
  }

  /**
   * Reads a required configuration value.
   *
   * @typeParam T - The expected value type
   * @param key - Configuration key
   * @returns The value
   * @throws {Error} If the key is absent (identifies the missing key)
   */
  getOrThrow<T>(key: string): T {
    const value = this.data[key];
    if (value === undefined) {
      throw new Error(`Configuration key "${key}" is not set.`);
    }
    return value as T;
  }

  /**
   * Reports whether a key is present in the configuration.
   *
   * A key is considered present when it exists in the configuration and its
   * value is not `undefined`.
   *
   * @param key - Configuration key
   * @returns `true` if the key has a non-undefined value
   */
  has(key: string): boolean {
    return this.data[key] !== undefined;
  }
}
