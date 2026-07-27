/**
 * Guard schematic — generates guard code (gated on auth-plugin).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a guard file.
 */
export function generateGuard(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const guardName = `require${names.pascal}`;
  const fileName = `src/guards/${names.kebab}.guard.ts`;
  const contents =
    `import { IRequestContext } from '@hono-enterprise/common';\n\nexport function ${guardName}() {\n  return async (ctx: IRequestContext, next: () => Promise<void>) => {\n    // Guard logic\n    await next();\n  };\n}\n`;
  return [{ path: fileName, contents }];
}
