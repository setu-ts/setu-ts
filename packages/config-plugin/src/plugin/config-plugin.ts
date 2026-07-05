/**
 * ConfigPlugin — registers a type-safe {@linkcode IConfig} under
 * `CAPABILITIES.CONFIG`.
 *
 * Consumes `CAPABILITIES.RUNTIME` and provides `CAPABILITIES.CONFIG`.
 * Registration is async because env files are loaded asynchronously.
 *
 * @module
 */
import type { IConfig, IPlugin, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { ConfigService } from '../services/config-service.ts';
import type { EnvLoaderOptions } from '../services/env-loader.ts';
import { loadEnv } from '../services/env-loader.ts';
import { expandVariables as expandConfigVariables } from '../services/variable-expander.ts';
import type { StructuralSchema } from '../validators/config-validator.ts';
import { validateConfig } from '../validators/config-validator.ts';

/**
 * Options for {@linkcode ConfigPlugin}.
 *
 * @since 0.1.0
 */
export interface ConfigPluginOptions {
  /**
   * Path or paths to `.env` files to load. Defaults to no file loading.
   * When supplied, the runtime must provide `fs` (absent on edge platforms).
   */
  readonly envFilePath?: string | readonly string[];

  /**
   * A structural schema (e.g., a Zod schema) for validating configuration at
   * startup. When provided, the schema's `parse()` is called once after
   * merging and expansion, and the parsed output is stored as the
   * configuration snapshot. This preserves Zod coercions and defaults.
   */
  readonly validationSchema?: StructuralSchema<unknown>;

  /**
   * When `true` (default), expand `${NAME}` references in values.
   * Set to `false` to disable variable expansion.
   */
  readonly expandVariables?: boolean;
}

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'config-plugin';

/**
 * Creates the ConfigPlugin.
 *
 * The plugin depends on the runtime plugin (`CAPABILITIES.RUNTIME`) and
 * registers its {@linkcode IConfig} under `CAPABILITIES.CONFIG` at
 * `PLUGIN_PRIORITY.HIGH` (100) so configuration is available before
 * most other plugins register.
 *
 * Registration may be async because env files are loaded asynchronously
 * through `runtime.fs`.
 *
 * @example
 * ```typescript
 * import { ConfigPlugin } from '@hono-enterprise/config-plugin';
 * import { z } from 'npm:zod';
 *
 * const AppConfigSchema = z.object({
 *   PORT: z.coerce.number().default(3000),
 *   DATABASE_URL: z.string().url(),
 * });
 *
 * app.register(ConfigPlugin({
 *   envFilePath: ['.env.local', '.env'],
 *   validationSchema: AppConfigSchema,
 *   expandVariables: true,
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function ConfigPlugin(options?: ConfigPluginOptions): IPlugin {
  const envFilePath = options?.envFilePath;
  const validationSchema = options?.validationSchema;
  const expandVariables = options?.expandVariables ?? true;

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    dependencies: [CAPABILITIES.RUNTIME],
    provides: [CAPABILITIES.CONFIG],
    consumes: [CAPABILITIES.RUNTIME],
    priority: PLUGIN_PRIORITY.HIGH,

    async register(ctx: IPluginContext): Promise<void> {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);

      const loaderOptions: EnvLoaderOptions = envFilePath === undefined ? {} : { envFilePath };

      // Load raw string values from environment and files.
      const loaded = await loadEnv(runtime, loaderOptions);
      const raw = expandVariables ? expandConfigVariables(loaded) : loaded;

      // If a validation schema is provided, validate and coerce.
      const data: Record<string, unknown> = validationSchema
        ? validateConfig(raw, validationSchema)
        : raw;

      // Register immutable config service.
      const config = new ConfigService(data);
      ctx.services.register<IConfig>(CAPABILITIES.CONFIG, config);
    },
  };
}
