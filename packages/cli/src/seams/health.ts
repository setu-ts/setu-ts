/**
 * The health-indicator seam.
 *
 * The one family whose registration site the ROADMAP described correctly:
 * `HealthPluginOptions.indicators` already exists, already takes INSTANCES of
 * `IHealthIndicator`, and the plugin registers each at `register()` time.
 *
 * Two shapes since M70h (A2). `health-plugin` ships with the `rest` template, so
 * a project the CLI itself decided is FUNCTIONAL was getting the one class in an
 * otherwise function-shaped project — and `IHealthIndicator` is only an
 * interface, so `{ name, check }` satisfies it perfectly well. Converting it by
 * hand did not work either: the barrel imported the symbol BY NAME and
 * constructed it with `new`, and M60's scanner requires that exact export, so
 * the artifact was dropped from the barrel and **the check silently stopped
 * running** — no type error, no lint error, no boot failure, `/health` still
 * reporting healthy. The remediation text even looped, because regenerating
 * restored the class the developer was replacing.
 *
 * The functional barrel spreads VALUES, which is what this file's own comment
 * already said the option wanted: "Instances, not constructors".
 *
 * @module
 */

import type { SeamArtifacts, SeamSpec } from './seam-spec.ts';
import {
  assembleSeamBarrel,
  renderList,
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
 * Renders `src/health/index.ts` for a generator mode.
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
    const symbol = classBased ? indicatorClassSymbol : indicatorValueSymbol;
    const imports = [
      `import type { IHealthIndicator } from '@setu-ts/common';`,
      renderSeamImports(names, (n) => [symbol(n)], (kebab) => `./${kebab}.indicator.ts`),
    ].filter((line) => line !== '').join('\n\n');

    // Instances, not constructors: `HealthPluginOptions.indicators` is
    // `readonly IHealthIndicator[]` and the plugin reads `.name` and binds
    // `.check` off each entry, so a class would fail the option's own type. The
    // functional shape IS the instance, so it needs no `new`.
    const entries = names.map((name) => {
      const derived = deriveNames(name);
      return classBased ? `new ${indicatorClassSymbol(derived)}()` : indicatorValueSymbol(derived);
    });

    return assembleSeamBarrel(header, imports, [
      `/** Every generated health indicator, for \`HealthPlugin({ indicators })\`. */\n` +
      `export const ${HEALTH_INDICATORS_EXPORT}: readonly IHealthIndicator[] = [${
        renderList(entries)
      }];`,
    ]);
  };
}

/** The health-indicator seam, in a class-based project. */
export const HEALTH_SEAM: SeamSpec = {
  schematic: 'health-indicator',
  dir: 'src/health',
  suffix: '.indicator.ts',
  importSymbols: (names) => [indicatorClassSymbol(names)],
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
  importSymbols: (names) => [indicatorValueSymbol(names)],
  barrel: 'src/health/index.ts',
  exports: [HEALTH_INDICATORS_EXPORT],
  requiresPlugin: 'health-plugin',
  renderBarrel: renderHealthBarrel(false),
};
