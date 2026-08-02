/**
 * Options shared by {@linkcode ConfigPlugin} and {@linkcode loadConfig}.
 *
 * They live in their own module because both entry points take the same
 * options object: the plugin registers what the standalone loader produces, so
 * one type describing one behaviour keeps them from drifting apart.
 *
 * @module
 */

import type { IConfig } from '@hono-enterprise/common';

import type { StructuralSchema } from './validators/config-validator.ts';

/**
 * Options for {@linkcode ConfigPlugin} and {@linkcode loadConfig}.
 *
 * @since 0.1.0
 */
export interface ConfigPluginOptions {
  /**
   * Path or paths to `.env` files to load. Defaults to no file loading.
   * When supplied, the runtime must provide `fs` (absent on edge platforms).
   *
   * Ignored when {@linkcode ConfigPluginOptions.instance} is set.
   */
  readonly envFilePath?: string | readonly string[];

  /**
   * A structural schema (e.g., a Zod schema) for validating configuration at
   * startup. When provided, the schema's `parse()` is called once after
   * merging and expansion, and the parsed output is stored as the
   * configuration snapshot. This preserves Zod coercions and defaults.
   *
   * Ignored when {@linkcode ConfigPluginOptions.instance} is set — the supplied
   * snapshot has already been through whatever validation produced it.
   */
  readonly validationSchema?: StructuralSchema<unknown>;

  /**
   * When `true` (default), expand `${NAME}` references in values.
   * Set to `false` to disable variable expansion.
   *
   * Ignored when {@linkcode ConfigPluginOptions.instance} is set.
   */
  readonly expandVariables?: boolean;

  /**
   * An already-loaded configuration snapshot to use verbatim.
   *
   * Present → nothing is read from the environment or from disk, the three
   * options above are ignored, and this exact object becomes the application's
   * `CAPABILITIES.CONFIG` service. Absent → configuration is loaded normally.
   *
   * This exists so configuration can be resolved BEFORE plugins are
   * constructed — deciding which plugins to register from a value in the
   * environment — without the application then loading a second snapshot. Two
   * snapshots read at different moments can disagree, and the one the composer
   * branched on would not be the one handlers read.
   *
   * @example Composing from configuration, then reusing the same snapshot
   * ```typescript
   * import { createRuntimeServices } from '@hono-enterprise/runtime';
   * import { ConfigPlugin, loadConfig } from '@hono-enterprise/config-plugin';
   *
   * const config = await loadConfig(createRuntimeServices());
   * const plugins = [ConfigPlugin({ instance: config })];
   * ```
   * @since 0.2.0
   */
  readonly instance?: IConfig;
}
