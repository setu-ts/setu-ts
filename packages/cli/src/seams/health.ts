/**
 * The health-indicator seam.
 *
 * The one family whose registration site the ROADMAP described correctly:
 * `HealthPluginOptions.indicators` already existed and took instances of
 * `IHealthIndicator` — until M70d widened it to `HealthIndicatorEntry`, so an
 * entry may also be a factory that builds an indicator from the service
 * registry.
 *
 * Two shapes since M70h (A2). `health-plugin` ships with the `rest` template, so
 * a project the CLI itself decided is FUNCTIONAL was getting the one class in an
 * otherwise function-shaped project — and `IHealthIndicator` is only an
 * interface, so `{ name, check }` satisfies it perfectly well. Converting it by
 * hand did not work either: the barrel imported the symbol BY NAME and
 * constructed it with `new`, and M60's scanner requires that exact export, so
 * the artifact was dropped from the barrel and **the check silently stopped
 * running** — no type error, no lint error, no boot failure, `/health` still
 * reporting healthy.
 *
 * Since M70d the barrel writes no `new` anywhere: each artifact module owns a
 * zero-parameter factory, and the barrel references that factory by name. The
 * factory is the single construction site, and — because the artifact file is
 * developer-owned and never rewritten — it is where a developer wires a
 * dependency in by taking `services`.
 *
 * @module
 */

import type { SeamArtifacts, SeamSpec } from './seam-spec.ts';
import {
  assembleSeamBarrel,
  renderExportedArray,
  renderSeamImports,
  seamHeader,
  seamNames,
} from './seam-spec.ts';
import type { DerivedNames } from '../utils/names.ts';
import { deriveNames } from '../utils/names.ts';

/** Barrel export naming every generated health indicator. */
export const HEALTH_INDICATORS_EXPORT = 'HEALTH_INDICATORS';

/**
 * The class a decorated project's indicator module exports.
 *
 * @param names - The artifact's derived naming forms
 * @returns The exported class name
 */
export function indicatorClassSymbol(names: DerivedNames): string {
  return `${names.pascal}HealthIndicator`;
}

/**
 * The factory a decorated project's indicator module exports.
 *
 * Owned here rather than in the schematic, for the reason
 * {@linkcode SeamSpec.importSymbols} gives: the renderer that names a symbol and
 * the scanner that admits a file by it must read ONE definition.
 *
 * @param names - The artifact's derived naming forms
 * @returns The exported factory's name
 */
export function indicatorClassFactorySymbol(names: DerivedNames): string {
  return `create${names.pascal}HealthIndicator`;
}

/**
 * The value a functional project's indicator module exports.
 *
 * Owned here rather than in the schematic, for the reason
 * {@linkcode SeamSpec.importSymbols} gives: the renderer that names a symbol and
 * the scanner that admits a file by it must read ONE definition.
 *
 * @param names - The artifact's derived naming forms
 * @returns The exported constant's name
 */
export function indicatorValueSymbol(names: DerivedNames): string {
  return `${names.camel}Indicator`;
}

/**
 * The factory a functional project's indicator module exports.
 *
 * @param names - The artifact's derived naming forms
 * @returns The exported factory's name
 */
export function indicatorValueFactorySymbol(names: DerivedNames): string {
  return `create${names.pascal}Indicator`;
}

/**
 * Renders `src/health/index.ts` for a generator mode.
 *
 * The barrel writes no `new`: it references each artifact's factory by name, so
 * the artifact module is the single construction site.
 *
 * @param classBased - Whether the project's indicators are classes
 * @returns A barrel renderer for that mode
 */
function renderHealthBarrel(classBased: boolean): (artifacts: SeamArtifacts) => string {
  return (artifacts: SeamArtifacts): string => {
    const names = seamNames(artifacts, 'health-indicator');
    const header = seamHeader('setu generate health-indicator', [
      `HealthPlugin({ indicators: [...${HEALTH_INDICATORS_EXPORT}] })`,
    ]);
    const factory = classBased ? indicatorClassFactorySymbol : indicatorValueFactorySymbol;
    const imports = [
      `import type { HealthIndicatorEntry } from '@setu-ts/health-plugin';`,
      renderSeamImports(names, (n) => [factory(n)], (kebab) => `./${kebab}.indicator.ts`),
    ].filter((line) => line !== '').join('\n\n');

    // Bare factory references, not `new`: the factory is the single construction
    // site, and it lives in the developer-owned artifact module, so a dependency
    // wired into it survives the next `setu generate`.
    const entries = names.map((name) => factory(deriveNames(name)));

    return assembleSeamBarrel(header, imports, [
      `/** Every generated health indicator, for \`HealthPlugin({ indicators })\`. */\n` +
      renderExportedArray(HEALTH_INDICATORS_EXPORT, 'HealthIndicatorEntry', entries),
    ]);
  };
}

/** The health-indicator seam, in a class-based project. */
export const HEALTH_SEAM: SeamSpec = {
  schematic: 'health-indicator',
  dir: 'src/health',
  suffix: '.indicator.ts',
  importSymbols: (names) => [indicatorClassFactorySymbol(names)],
  barrel: 'src/health/index.ts',
  exports: [HEALTH_INDICATORS_EXPORT],
  requiresPlugin: 'health-plugin',
  renderBarrel: renderHealthBarrel(true),
};

/** The health-indicator seam, in a functional project. */
export const FUNCTIONAL_HEALTH_SEAM: SeamSpec = {
  schematic: 'health-indicator',
  dir: 'src/health',
  suffix: '.indicator.ts',
  importSymbols: (names) => [indicatorValueFactorySymbol(names)],
  barrel: 'src/health/index.ts',
  exports: [HEALTH_INDICATORS_EXPORT],
  requiresPlugin: 'health-plugin',
  renderBarrel: renderHealthBarrel(false),
};
