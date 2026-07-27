/**
 * Health indicator schematic — generates health indicator code (gated on health-plugin).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a health indicator file.
 */
export function generateHealthIndicator(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const fileName = `src/health/${names.kebab}.indicator.ts`;
  const contents =
    `import { IHealthIndicator } from '@hono-enterprise/common';\n\nexport class ${names.pascal}HealthIndicator implements IHealthIndicator {\n  name = '${names.kebab}';\n  async status() {\n    return { healthy: true, details: { status: 'ok' } };\n  }\n}\n`;
  return [{ path: fileName, contents }];
}
