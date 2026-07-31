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

import type { ConfigPluginOptions } from '../options.ts';
import { loadConfig } from '../services/load-config.ts';

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
  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    dependencies: [CAPABILITIES.RUNTIME],
    provides: [CAPABILITIES.CONFIG],
    consumes: [CAPABILITIES.RUNTIME],
    priority: PLUGIN_PRIORITY.HIGH,

    async register(ctx: IPluginContext): Promise<void> {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);

      // Delegation, not a second copy: `loadConfig` owns merging, expansion,
      // validation, and the `instance` short-circuit, so a snapshot built
      // before the application starts and one built here are the same code.
      const config = await loadConfig(runtime, options);
      ctx.services.register<IConfig>(CAPABILITIES.CONFIG, config);
    },
  };
}
