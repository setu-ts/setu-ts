/**
 * Metric schematic (gated on `metrics-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { CUSTOM_METRICS_EXPORT, metricConfigExport, METRICS_SEAM } from '../seams/metrics.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * Generates a metric module and regenerates the seam barrel that pre-registers it.
 *
 * The module carries two exports rather than one, and they are not redundant: the
 * `NamedMetricConfig` is how the metric EXISTS at boot — `MetricsPlugin` materializes
 * `customMetrics` at `onInit`, and the Prometheus renderer emits a metric's `# HELP`
 * and `# TYPE` lines even with no samples, so it is visible in `GET /metrics`
 * immediately — while the accessor is how application code increments it.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the metrics already present, for the barrel
 * @returns The metric at `src/metrics/<kebab>.metric.ts`, plus the managed
 *   `src/metrics/index.ts` barrel
 */
export function generateMetric(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const snake = names.kebab.replace(/-/g, '_');
  const configConst = metricConfigExport(names.screaming);
  const contents = `import { CAPABILITIES } from '@setu-ts/common';
import type { ICounter, IMetricsService, IServiceRegistry } from '@setu-ts/common';
import type { NamedMetricConfig } from '@setu-ts/metrics-plugin';

/** Prometheus name of the ${names.kebab} counter. */
export const ${names.screaming}_TOTAL = '${snake}_total';

/**
 * Declaration of the ${names.kebab} counter.
 *
 * Pre-registered through the \`${CUSTOM_METRICS_EXPORT}\` barrel in
 * \`src/metrics/index.ts\`, which \`setu.config.ts\` passes to \`MetricsPlugin\` — so the
 * metric appears in \`GET /metrics\` from startup, before anything increments it.
 */
export const ${configConst}: NamedMetricConfig = {
  name: ${names.screaming}_TOTAL,
  type: 'counter',
  help: 'Total ${names.kebab} events.',
  labels: ['outcome'],
};

/**
 * Fetches the ${names.kebab} counter so application code can record on it.
 *
 * Returns the instrument the declaration above already registered; calling this
 * before that registration would create it on first use instead.
 *
 * @param services - The service registry to resolve the metrics capability from
 * @returns The counter instrument
 */
export function ${names.camel}Counter(services: IServiceRegistry): ICounter {
  const metrics = services.get<IMetricsService>(CAPABILITIES.METRICS);
  // The declaration IS the options, so help text and labels have one home rather than
  // being restated here — a second copy would drift from the registered metric.
  return metrics.counter(${names.screaming}_TOTAL, ${configConst});
}
`;
  return [
    { path: `src/metrics/${names.kebab}.metric.ts`, contents },
    {
      path: METRICS_SEAM.barrel,
      contents: METRICS_SEAM.renderBarrel({
        metric: seamNames(options.artifacts, 'metric', names.kebab),
      }),
      managed: true,
    },
  ];
}
