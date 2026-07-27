/**
 * Service schematic — generates a service class.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a service file.
 */
export function generateService(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const serviceName = names.pascal + 'Service';
  const fileName = `src/services/${names.kebab}.service.ts`;
  const contents =
    `export class ${serviceName} {\n  get(): string {\n    return 'Hello from ${serviceName}';\n  }\n}\n`;
  return [{ path: fileName, contents }];
}
