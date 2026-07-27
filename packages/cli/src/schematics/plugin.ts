/**
 * Plugin schematic — generates a plugin module.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a plugin file.
 */
export function generatePlugin(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const pluginName = names.pascal + 'Plugin';
  const fileName = `src/plugins/${names.kebab}.plugin.ts`;
  const contents =
    `import { IPlugin } from '@hono-enterprise/common';\n\nexport const ${pluginName}: IPlugin = {\n  name: "${names.kebab}-plugin",\n  version: "1.0.0",\n  provides: ["${names.kebab}"],\n  register(ctx) {\n    // Plugin implementation\n  },\n};\n`;
  return [{ path: fileName, contents }];
}
