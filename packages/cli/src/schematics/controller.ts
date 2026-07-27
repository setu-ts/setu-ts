/**
 * Controller schematic — generates a controller class.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a controller file.
 */
export function generateController(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const controllerName = names.pascal + 'Controller';
  const fileName = `src/controllers/${names.kebab}.controller.ts`;
  const contents =
    `import { Controller, Get } from '@hono-enterprise/decorator-plugin';\n\n@Controller('/${names.kebab}')\nexport class ${controllerName} {\n  @Get()\n  GET(): string {\n    return 'Hello from ${controllerName}';\n  }\n}\n`;
  return [{ path: fileName, contents }];
}
