/**
 * Middleware schematic — generates middleware factory code.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a middleware file.
 */
export function generateMiddleware(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const middlewareName = names.pascal + 'Middleware';
  const fileName = `src/middleware/${names.kebab}.middleware.ts`;
  const contents =
    `import type { RequestContext } from '@hono-enterprise/kernel';\n\nexport function ${middlewareName}() {\n  return async (ctx: RequestContext, next: () => Promise<void>) => {\n    // Middleware logic\n    await next();\n  };\n}\n`;
  return [{ path: fileName, contents }];
}
