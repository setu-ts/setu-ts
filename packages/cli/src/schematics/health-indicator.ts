/**
 * Health indicator schematic (gated on `health-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { HEALTH_INDICATORS_EXPORT, HEALTH_SEAM } from '../seams/health.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * Generates a health indicator and regenerates the seam barrel that registers it.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the indicators already present, for the barrel
 * @returns The indicator at `src/health/<kebab>.indicator.ts`, plus the managed
 *   `src/health/index.ts` barrel
 */
export function generateHealthIndicator(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import type { HealthCheckResult, IHealthIndicator } from '@setu-ts/common';

/**
 * Reports the health of the ${names.kebab} dependency.
 *
 * Registered through the \`${HEALTH_INDICATORS_EXPORT}\` barrel in
 * \`src/health/index.ts\`, which \`setu.config.ts\` passes to \`HealthPlugin\` — so this
 * class needs no further wiring, and \`${names.kebab}\` appears in \`GET /health\`.
 * From inside a plugin, \`ctx.health.register('${names.kebab}', () => indicator.check())\`
 * is the equivalent.
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
  return [
    { path: `src/health/${names.kebab}.indicator.ts`, contents },
    {
      path: HEALTH_SEAM.barrel,
      contents: HEALTH_SEAM.renderBarrel({
        'health-indicator': seamNames(options.artifacts, 'health-indicator', names.kebab),
      }),
      managed: true,
    },
  ];
}
