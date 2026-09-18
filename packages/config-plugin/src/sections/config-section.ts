/**
 * Typed configuration-section definitions and cached reads.
 *
 * @module
 */

import type { IConfig } from '@setu-ts/common';

import type { StructuralSchema } from '../validators/config-validator.ts';

/**
 * A typed declaration for a related group of flat configuration keys.
 *
 * `prefix` is prepended to each entry in `keys` before reading the flat
 * configuration snapshot. The schema receives an object whose keys are the
 * prefix-stripped entries from `keys`.
 *
 * @typeParam T - The validated output produced by the section schema
 * @since 0.6.0
 */
export interface ConfigSection<T> {
  /** Prefix prepended to every declared key when reading the configuration. */
  readonly prefix: string;
  /** Prefix-stripped keys that belong to this section. */
  readonly keys: readonly string[];
  /** Schema that validates the selected, prefix-stripped values. */
  readonly schema: StructuralSchema<T>;
}

/** Internal cache entry retaining a section definition/value correlation. */
export interface IConfigSectionCacheEntry<T> {
  readonly definition: ConfigSection<T>;
  readonly value: T;
}

type UnknownConfigSectionCacheEntry = IConfigSectionCacheEntry<unknown>;

const sectionCache = new WeakMap<
  IConfig,
  ReadonlyMap<ConfigSection<unknown>, UnknownConfigSectionCacheEntry>
>();

/**
 * Declares a typed section over flat configuration keys.
 *
 * Every entry in `keys` is read as `prefix + key`; the schema receives those
 * values under their prefix-stripped names. For example, `prefix:
 * 'DATABASE_'` and `keys: ['URL']` read `DATABASE_URL` and pass `{ URL }` to
 * the schema. The returned declaration is an immutable snapshot, so later
 * mutations to the caller-owned definition cannot change a cached section.
 *
 * @typeParam T - The validated output produced by `schema`
 * @param definition - The flat-key prefix, declared keys, and schema
 * @returns A reusable section definition for `ConfigPluginOptions.sections`
 * @example
 * ```typescript
 * const database = defineConfigSection({
 *   prefix: 'DATABASE_',
 *   keys: ['URL'],
 *   schema: { parse: (input) => input },
 * });
 * ```
 * @since 0.6.0
 */
export function defineConfigSection<T>(definition: ConfigSection<T>): ConfigSection<T> {
  return Object.freeze({
    ...definition,
    keys: Object.freeze([...definition.keys]),
  });
}

/**
 * Reads a startup-validated configuration section.
 *
 * The value is the exact output of the section schema that validated this
 * configuration snapshot during loading. It is never parsed or asserted at
 * read time.
 *
 * @typeParam T - The validated section value
 * @param config - The configuration snapshot registered by ConfigPlugin
 * @param definition - The section declaration passed to the plugin at startup
 * @returns The validated section value
 * @throws {Error} If this configuration did not validate the definition
 * @since 0.6.0
 */
export function getConfigSection<T>(config: IConfig, definition: ConfigSection<T>): T {
  const entry = sectionCache.get(config)?.get(definition);
  if (entry === undefined || !isEntryForDefinition(entry, definition)) {
    throw new Error(
      `Configuration section "${definition.prefix}" was not validated at startup.`,
    );
  }

  // The cache is populated only with this definition's schema.parse() output.
  return entry.value;
}

/** Selects declared prefix-plus-key values for startup validation. */
export function selectConfigSectionValues(
  config: IConfig,
  definition: ConfigSection<unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const key of definition.keys) {
    const value = config.get<unknown>(`${definition.prefix}${key}`);
    if (value !== undefined) {
      values[key] = value;
    }
  }

  return values;
}

/** Replaces every cached section for one configuration snapshot atomically. */
export function replaceConfigSectionCache(
  config: IConfig,
  entries: ReadonlyMap<ConfigSection<unknown>, UnknownConfigSectionCacheEntry>,
): void {
  sectionCache.set(config, entries);
}

/** Creates an internally-correlated cache entry from one schema parse result. */
export function createConfigSectionCacheEntry<T>(
  definition: ConfigSection<T>,
  value: T,
): IConfigSectionCacheEntry<T> {
  return { definition, value };
}

function isEntryForDefinition<T>(
  entry: UnknownConfigSectionCacheEntry,
  definition: ConfigSection<T>,
): entry is IConfigSectionCacheEntry<T> {
  return entry.definition === definition;
}
