/**
 * Health indicator schematic (gated on `health-plugin`).
 *
 * Mode-aware since M70h (A2). `health-plugin` ships with the `rest` template, so
 * a functional project was getting the one class in an otherwise function-shaped
 * project — and `IHealthIndicator` is only an interface, so the class was the
 * CLI's choice rather than the contract's.
 *
 * Since M70d both shapes also export a zero-parameter factory, and the barrel
 * references that factory by name — it writes no `new`. The factory is the
 * single construction site, and it is where a developer wires a dependency in:
 * take `services` and resolve a capability from it.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import {
  FUNCTIONAL_HEALTH_SEAM,
  HEALTH_INDICATORS_EXPORT,
  HEALTH_SEAM,
  indicatorClassFactorySymbol,
  indicatorClassSymbol,
  indicatorValueFactorySymbol,
  indicatorValueSymbol,
} from '../seams/health.ts';
import { seamNames } from '../seams/seam-spec.ts';
import { generatorMode } from '../utils/generator-mode.ts';

/**
 * The shared JSDoc body, so the two shapes cannot drift about how they register.
 *
 * @param names - Naming forms derived from the user's input
 * @returns The doc comment lines, without the surrounding delimiters
 */
function wiringDoc(names: DerivedNames): string {
  return ` * Reports the health of the ${names.kebab} dependency.
 *
 * Registered through the \`${HEALTH_INDICATORS_EXPORT}\` barrel in
 * \`src/health/index.ts\`, which \`setu.config.ts\` passes to \`HealthPlugin\` — so
 * this needs no further wiring, and \`${names.kebab}\` appears in \`GET /health\`.
 * From inside a plugin, \`ctx.health.register('${names.kebab}', () => …)\` is the
 * equivalent.`;
}

/**
 * The factory's JSDoc, with the one-line edit that takes `services`.
 *
 * @param factory - The emitted factory's name
 * @param target - The factory's return type name
 * @returns The doc comment lines, without the surrounding delimiters
 */
function factoryDoc(factory: string, target: string): string {
  return ` * Builds the indicator. The barrel references this factory by name, so it is
 * the single construction site — and the place to wire a dependency in.
 * \`HealthPluginOptions.indicators\` accepts a factory that builds an indicator
 * from the service registry, called at the \`onInit\` phase, after every plugin
 * has registered, so to take a dependency change the one line to:
 *
 * \`\`\`ts
 * export function ${factory}(services: IServiceRegistry): ${target} {
 *   // resolve a capability from services and build with it
 * }
 * \`\`\``;
}

/**
 * Renders the class shape, for a project carrying `decorator-plugin`.
 *
 * @param names - Naming forms derived from the user's input
 * @returns The module contents
 */
function renderClassIndicator(names: DerivedNames): string {
  const factory = indicatorClassFactorySymbol(names);
  const cls = indicatorClassSymbol(names);
  return `import type { HealthCheckResult, IHealthIndicator } from '@setu-ts/common';

/**
${wiringDoc(names)}
 */
export class ${cls} implements IHealthIndicator {
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

/**
${factoryDoc(factory, cls)}
 */
export function ${factory}(): ${cls} {
  return new ${cls}();
}
`;
}

/**
 * Renders the value shape, for a project without decorators.
 *
 * `IHealthIndicator` is an interface, so an object literal satisfies it — and
 * the barrel wanted an instance all along.
 *
 * @param names - Naming forms derived from the user's input
 * @returns The module contents
 */
function renderValueIndicator(names: DerivedNames): string {
  const factory = indicatorValueFactorySymbol(names);
  const value = indicatorValueSymbol(names);
  return `import type { HealthCheckResult, IHealthIndicator } from '@setu-ts/common';

/**
${wiringDoc(names)}
 */
export const ${value}: IHealthIndicator = {
  name: '${names.kebab}',

  /**
   * Performs the check.
   *
   * @returns \`up\` while the dependency is reachable
   */
  check(): Promise<HealthCheckResult> {
    // Replace with the real probe; report 'down' or 'degraded' on failure.
    return Promise.resolve({ status: 'up', data: { checked: '${names.kebab}' } });
  },
};

/**
${factoryDoc(factory, 'IHealthIndicator')}
 */
export function ${factory}(): IHealthIndicator {
  return ${value};
}
`;
}

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
  const classBased = generatorMode(options.plugins) === 'class-based';
  const seam = classBased ? HEALTH_SEAM : FUNCTIONAL_HEALTH_SEAM;

  return [
    {
      path: `src/health/${names.kebab}.indicator.ts`,
      contents: classBased ? renderClassIndicator(names) : renderValueIndicator(names),
    },
    {
      path: seam.barrel,
      contents: seam.renderBarrel({
        'health-indicator': seamNames(options.artifacts, 'health-indicator', names.kebab),
      }),
      managed: true,
    },
  ];
}
