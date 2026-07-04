/**
 * Configuration contract, fulfilled by the ConfigPlugin under
 * `CAPABILITIES.CONFIG`.
 *
 * @module
 */

/**
 * Type-safe configuration access. Values originate from environment
 * variables and `.env` files, validated at startup.
 *
 * @example
 * ```typescript
 * const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);
 * const port = config.get<number>('PORT', { default: 3000 });
 * const dbUrl = config.getOrThrow<string>('DATABASE_URL');
 * ```
 * @since 0.1.0
 */
export interface IConfig {
  /**
   * Reads a configuration value.
   *
   * @typeParam T - The expected value type
   * @param key - Configuration key
   * @returns The value, or `undefined` when absent
   */
  get<T>(key: string): T | undefined;
  /**
   * Reads a configuration value with a fallback.
   *
   * @typeParam T - The expected value type
   * @param key - Configuration key
   * @param options - Default returned when the key is absent
   * @returns The value, or the default
   */
  get<T>(key: string, options: { readonly default: T }): T;
  /**
   * Reads a required configuration value.
   *
   * @typeParam T - The expected value type
   * @param key - Configuration key
   * @returns The value
   * @throws {Error} If the key is absent
   */
  getOrThrow<T>(key: string): T;
  /**
   * Reports whether a key is present.
   *
   * @param key - Configuration key
   * @returns `true` if the key has a value
   */
  has(key: string): boolean;
}
