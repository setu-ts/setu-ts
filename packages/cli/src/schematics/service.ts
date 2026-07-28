/**
 * Service schematic — a plain service class with no framework coupling.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a service class.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: a service has no runtime- or plugin-specific shape
 * @returns One file at `src/services/<kebab>.service.ts`
 */
export function generateService(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `/**
 * ${names.pascal} domain service.
 */
export class ${names.pascal}Service {
  /**
   * Replace with the service's real behavior.
   *
   * @returns A placeholder value
   */
  describe(): string {
    return '${names.kebab}';
  }
}
`;
  return [{ path: `src/services/${names.kebab}.service.ts`, contents }];
}
