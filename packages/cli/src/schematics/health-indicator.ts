/**
 * Health indicator schematic (gated on `health-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a health indicator.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: indicators are runtime-agnostic
 * @returns One file at `src/health/<kebab>.indicator.ts`
 */
export function generateHealthIndicator(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents =
    `import type { HealthCheckResult, IHealthIndicator } from '@hono-enterprise/common';

/**
 * Reports the health of the ${names.kebab} dependency.
 *
 * Register it with the HealthPlugin's \`indicators\` option, or from a plugin
 * with \`ctx.health.register('${names.kebab}', () => indicator.check())\`.
 */
export class ${names.pascal}HealthIndicator implements IHealthIndicator {
  readonly name = '${names.kebab}';

  /**
   * Performs the check.
   *
   * @returns \`up\` while the dependency is reachable
   */
  check(): Promise<HealthCheckResult> {
    // Replace with the real probe; report 'down' or 'degraded' on failure.
    return Promise.resolve({ status: 'up', data: { checked: '${names.kebab}' } });
  }
}
`;
  return [{ path: `src/health/${names.kebab}.indicator.ts`, contents }];
}
