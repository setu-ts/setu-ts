/**
 * Plugin schematic — a plugin factory registering one service under its own
 * capability token.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a plugin module.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: the plugin shape is runtime-agnostic
 * @returns One file at `src/plugins/<kebab>.ts`
 */
export function generatePlugin(
  names: DerivedNames,
  _options: SchematicOptions,
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
  return [{ path: `src/plugins/${names.kebab}.ts`, contents }];
}
