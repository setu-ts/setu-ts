/**
 * The metric seam.
 *
 * `MetricsPluginOptions.customMetrics` exists but is DECLARATIVE — it takes
 * `NamedMetricConfig` (`{ name, type, help, labels? }`), not the
 * `(services) => ICounter` accessor the schematic emits. So the schematic emits both:
 * the config is how the metric EXISTS at boot, the accessor is how application code
 * increments it. They are not redundant.
 *
 * The wiring is observable rather than nominal: the Prometheus renderer emits
 * `# HELP` and `# TYPE` before iterating a metric's samples, so a pre-registered
 * counter appears in `GET /metrics` with zero application code having run.
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

/** Barrel export naming every generated metric definition. */
export const CUSTOM_METRICS_EXPORT = 'CUSTOM_METRICS';

/**
 * The name of the `NamedMetricConfig` constant a generated metric exports.
 *
 * @param screaming - The artifact's SCREAMING_SNAKE name
 * @returns The constant's identifier
 */
export function metricConfigExport(screaming: string): string {
  return `${screaming}_METRIC`;
}

/**
 * Symbols the barrel imports from one metric module.
 *
 * The declaration only — the accessor is for application code, not the barrel. A metric
 * generated before this seam existed has no declaration at all, which is why the scanner
 * checks exports: a barrel regenerated over one named a constant the file did not have,
 * and the project stopped compiling.
 *
 * @param names - The artifact's derived naming forms
 * @returns The symbols to import
 */
function importSymbols(names: DerivedNames): readonly string[] {
  return [metricConfigExport(names.screaming)];
}

/**
 * Renders `src/metrics/index.ts`.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderMetricsBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'metric');
  const header = seamHeader('setu generate metric', [
    `MetricsPlugin({ customMetrics: [...${CUSTOM_METRICS_EXPORT}] })`,
  ]);
  const imports = [
    `import type { NamedMetricConfig } from '@setu-ts/metrics-plugin';`,
    renderSeamImports(names, importSymbols, (kebab) => `./${kebab}.metric.ts`),
  ].filter((line) => line !== '').join('\n\n');

  const entries = names.map((name) => metricConfigExport(deriveNames(name).screaming));

  return assembleSeamBarrel(header, imports, [
    `/** Every generated metric definition, for \`MetricsPlugin({ customMetrics })\`. */\n` +
    renderExportedArray(CUSTOM_METRICS_EXPORT, 'NamedMetricConfig', entries),
  ]);
}

/** The metric seam. */
export const METRICS_SEAM: SeamSpec = {
  schematic: 'metric',
  dir: 'src/metrics',
  suffix: '.metric.ts',
  importSymbols,
  barrel: 'src/metrics/index.ts',
  exports: [CUSTOM_METRICS_EXPORT],
  requiresPlugin: 'metrics-plugin',
  renderBarrel: renderMetricsBarrel,
};
