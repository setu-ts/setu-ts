/**
 * Route schematic — generates route registration code.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a routes file.
 */
export function generateRoute(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const fileName = `src/routes/${names.kebab}.routes.ts`;
  const contents =
    `import type { RequestContext } from '@hono-enterprise/kernel';\n\nexport function register${names.pascal}Routes(ctx: RequestContext) {\n  ctx.router.get('/${names.kebab}', (ctx) => ctx.response.json({ message: 'Hello from ${names.kebab}' }));\n}\n`;
  return [{ path: fileName, contents }];
}
