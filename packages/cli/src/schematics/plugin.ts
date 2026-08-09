/**
 * Plugin schematic — a plugin factory registering one service under its own
 * capability token.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { GENERATED_PLUGINS_EXPORT, PLUGINS_SEAM } from '../seams/plugins.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * Generates a plugin module and regenerates the seam barrel that registers it.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the plugins already present, for the barrel
 * @returns The plugin at `src/plugins/<kebab>.plugin.ts`, plus the managed
 *   `src/plugins/index.ts` barrel
 */
export function generatePlugin(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import { createCapabilityToken } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';

/** Capability token this plugin provides. */
export const ${names.screaming} = createCapabilityToken('${names.kebab}');

/** The service registered under {@linkcode ${names.screaming}}. */
export interface I${names.pascal}Service {
  /** Replace with the capability this plugin publishes. */
  describe(): string;
}

/**
 * Registers the ${names.kebab} capability.
 *
 * Registered for you through the \`${GENERATED_PLUGINS_EXPORT}\` barrel in
 * \`src/plugins/index.ts\`, which \`setu.config.ts\` spreads into
 * \`createApplication({ plugins })\` — so this module needs no further wiring. Delete
 * this file to stop registering it; the barrel is regenerated from the directory.
 *
 * @returns The plugin to pass to \`createApplication({ plugins: [...] })\`
 */
export function ${names.pascal}Plugin(): IPlugin {
  return {
    name: '${names.kebab}',
    version: '0.1.0',
    provides: [${names.screaming}],
    register(ctx: IPluginContext): void {
      const service: I${names.pascal}Service = {
        describe: () => '${names.kebab}',
      };
      ctx.services.register(${names.screaming}, service);
    },
  };
}
`;
  return [
    // `<kebab>.plugin.ts`, not the bare `<kebab>.ts` this schematic wrote before the
    // seam existed: the barrel is regenerated from a directory scan, and a suffix of
    // `.ts` would admit any module a developer put here — the barrel would then import
    // a `<Pascal>Plugin` symbol they never wrote.
    { path: `src/plugins/${names.kebab}.plugin.ts`, contents },
    {
      path: PLUGINS_SEAM.barrel,
      contents: PLUGINS_SEAM.renderBarrel({
        plugin: seamNames(options.artifacts, 'plugin', names.kebab),
      }),
      managed: true,
    },
  ];
}
