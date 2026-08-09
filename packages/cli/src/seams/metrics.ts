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
  renderList,
  renderSeamImports,
  seamHeader,
  seamNames,
} from './seam-spec.ts';
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
    renderSeamImports(
      names,
      (n) => metricConfigExport(n.screaming),
      (kebab) => `./${kebab}.metric.ts`,
    ),
  ].filter((line) => line !== '').join('\n\n');

  const entries = names.map((name) => metricConfigExport(deriveNames(name).screaming));

  return assembleSeamBarrel(header, imports, [
    `/** Every generated metric definition, for \`MetricsPlugin({ customMetrics })\`. */\n` +
    `export const ${CUSTOM_METRICS_EXPORT}: readonly NamedMetricConfig[] = [${
      renderList(entries)
    }];`,
  ]);
}

/** The metric seam. */
export const METRICS_SEAM: SeamSpec = {
  schematic: 'metric',
  dir: 'src/metrics',
  suffix: '.metric.ts',
  barrel: 'src/metrics/index.ts',
  exports: [CUSTOM_METRICS_EXPORT],
  requiresPlugin: 'metrics-plugin',
  renderBarrel: renderMetricsBarrel,
};
