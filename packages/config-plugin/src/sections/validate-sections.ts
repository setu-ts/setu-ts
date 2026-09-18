/**
 * Startup validation for typed configuration sections.
 *
 * @module
 */

import type { IConfig } from '@setu-ts/common';

import {
  createConfigSectionCacheEntry,
  replaceConfigSectionCache,
  selectConfigSectionValues,
} from './config-section.ts';
import type { ConfigSection, IConfigSectionCacheEntry } from './config-section.ts';

/**
 * Validates all declared sections and replaces their cache for a snapshot.
 *
 * @param config - The resolved configuration snapshot
 * @param sections - Definitions to validate before the application starts
 * @throws {Error} If a section schema rejects its selected values
 */
export function validateConfigSections(
  config: IConfig,
  sections: readonly ConfigSection<unknown>[],
): void {
  const entries = new Map<ConfigSection<unknown>, IConfigSectionCacheEntry<unknown>>();

  for (const section of sections) {
    try {
      const selected = selectConfigSectionValues(config, section);
      const value = section.schema.parse(selected);
      entries.set(section, createConfigSectionCacheEntry(section, value));
    } catch {
      // Section schema diagnostics can contain configuration values. Never
      // attach their message or cause to an error that crosses startup.
      // An injected snapshot can be reused, so a failed revalidation must not
      // leave a section value cached from an earlier successful load.
      replaceConfigSectionCache(
        config,
        new Map<ConfigSection<unknown>, IConfigSectionCacheEntry<unknown>>(),
      );
      throw new Error(`Configuration section "${section.prefix}" validation failed.`);
    }
  }

  replaceConfigSectionCache(config, entries);
}
