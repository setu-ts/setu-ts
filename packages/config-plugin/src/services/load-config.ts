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

import {
  approvedReferenceAliases,
  buildConfigProvenanceEntries,
  compileConfigDiagnosticsPolicy,
  storeConfigProvenance,
} from '../diagnostics/provenance.ts';
import type { ConfigPluginOptions } from '../options.ts';
import { validateConfigSections } from '../sections/validate-sections.ts';
import { ConfigService } from './config-service.ts';
import type { EnvLoaderOptions } from './env-loader.ts';
import { loadEnvWithProvenance } from './env-loader.ts';
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
 * if a configured file cannot be read, or if validation rejects the result.
 * Setting `envFileOptional` narrows the middle case: an ABSENT path is then
 * skipped, while a path that exists and cannot be read still throws
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
    validateConfigSections(instance, options?.sections ?? []);
    return instance;
  }

  // Compile the provenance policy once, before anything is read: an invalid
  // diagnostics option refuses before any source is touched.
  const diagnosticsOptions = options?.diagnostics;
  const policy = diagnosticsOptions === undefined
    ? null
    : compileConfigDiagnosticsPolicy(diagnosticsOptions);

  const envFilePath = options?.envFilePath;
  const loaderOptions: EnvLoaderOptions = envFilePath === undefined ? {} : {
    envFilePath,
    ...(options?.envFileOptional === undefined ? {} : { envFileOptional: options.envFileOptional }),
  };

  // Load raw string values from environment and files — the ONE pass, with
  // provenance observed as each existing merge step wins when enabled.
  const { values: loaded, sources } = await loadEnvWithProvenance(
    runtime,
    loaderOptions,
    policy === null
      ? undefined
      : { approvedKeys: policy.aliasByKey, aliasByPath: policy.aliasByPath },
  );
  // Approved reference ALIASES per expanded approved key: the raw reference
  // names are mapped (and unapproved ones dropped) inside the observer, so
  // no raw key name outlives the expansion step.
  const expansions = new Map<string, readonly string[]>();
  const raw = (options?.expandVariables ?? true)
    ? expandConfigVariables(
      loaded,
      policy === null ? undefined : {
        keys: policy.aliasByKey,
        onExpanded: (key, references) => {
          expansions.set(key, approvedReferenceAliases(policy, references));
        },
      },
    )
    : loaded;

  // If a validation schema is provided, validate and coerce.
  const validationSchema = options?.validationSchema;
  const data: Record<string, unknown> = validationSchema
    ? validateConfig(raw, validationSchema)
    : raw;

  const config = new ConfigService(data);
  if (policy !== null) {
    // Provenance is derived once, from the structures this pass already
    // produced — never from a second pass over values.
    // The builder receives only which APPROVED keys are present — presence is
    // read here, beside the values, so no value can reach the builder.
    const presentKeys = new Set(
      [...policy.aliasByKey.keys()].filter((key) => Object.hasOwn(data, key)),
    );
    storeConfigProvenance(
      config,
      buildConfigProvenanceEntries(
        policy,
        sources,
        expansions,
        presentKeys,
        validationSchema !== undefined,
      ),
    );
  }
  validateConfigSections(config, options?.sections ?? []);
  return config;
}
