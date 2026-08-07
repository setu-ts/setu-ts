/**
 * `loadConfig` — the single implementation behind every configuration snapshot
 * this package produces.
 *
 * {@linkcode ConfigPlugin} calls it at `register()`, and application code calls
 * it directly when configuration must be resolved before any plugin is
 * constructed. Both paths therefore honour the same options: a second copy of
 * load → expand → validate would silently stop applying `expandVariables` or
 * `validationSchema` on one of them.
 *
 * @module
 */

import type { IConfig, IRuntimeServices } from '@setu-ts/common';

import type { ConfigPluginOptions } from '../options.ts';
import { ConfigService } from './config-service.ts';
import type { EnvLoaderOptions } from './env-loader.ts';
import { loadEnv } from './env-loader.ts';
import { expandVariables as expandConfigVariables } from './variable-expander.ts';
import { validateConfig } from '../validators/config-validator.ts';

/**
 * Builds an immutable configuration snapshot from the environment.
 *
 * Sources are merged (runtime environment over `.env` files), `${NAME}`
 * references are expanded unless disabled, and a supplied schema validates and
 * coerces the result — in that order, so references observe final values and
 * the schema sees expanded ones.
 *
 * Supplying {@linkcode ConfigPluginOptions.instance} short-circuits all of
 * that and returns the given snapshot, which is what lets an application load
 * configuration once and hand the same object to the plugin.
 *
 * @example Reading configuration before an application exists
 * ```typescript
 * import { createRuntimeServices } from '@setu-ts/runtime';
 * import { loadConfig } from '@setu-ts/config-plugin';
 *
 * const config = await loadConfig(createRuntimeServices(), {
 *   envFilePath: ['.env.local', '.env'],
 * });
 * const port = config.get<number>('PORT', { default: 3000 });
 * ```
 * @param runtime - Runtime services providing `env` and, for files, `fs`
 * @param options - Loading, expansion, validation, and instance options
 * @returns The configuration snapshot
 * @throws {Error} If `envFilePath` is set and the runtime has no filesystem,
 * if a configured file cannot be read, or if validation rejects the result
 * @since 0.2.0
 */
export async function loadConfig(
  runtime: IRuntimeServices,
  options?: ConfigPluginOptions,
): Promise<IConfig> {
  // An injected snapshot is authoritative: nothing is read, so the caller's
  // configuration and the application's are the same object by construction.
  const instance = options?.instance;
  if (instance !== undefined) {
    return instance;
  }

  const envFilePath = options?.envFilePath;
  const loaderOptions: EnvLoaderOptions = envFilePath === undefined ? {} : { envFilePath };

  // Load raw string values from environment and files.
  const loaded = await loadEnv(runtime, loaderOptions);
  const raw = (options?.expandVariables ?? true) ? expandConfigVariables(loaded) : loaded;

  // If a validation schema is provided, validate and coerce.
  const validationSchema = options?.validationSchema;
  const data: Record<string, unknown> = validationSchema
    ? validateConfig(raw, validationSchema)
    : raw;

  return new ConfigService(data);
}
