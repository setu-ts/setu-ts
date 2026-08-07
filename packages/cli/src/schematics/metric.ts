/**
 * Metric schematic (gated on `metrics-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a metric registration module.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: metrics are runtime-agnostic
 * @returns One file at `src/metrics/<kebab>.metric.ts`
 */
export function generateMetric(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const snake = names.kebab.replace(/-/g, '_');
  const contents = `import { CAPABILITIES } from '@setu-ts/common';
import type { ICounter, IMetricsService, IServiceRegistry } from '@setu-ts/common';

/** Prometheus name of the ${names.kebab} counter. */
export const ${names.screaming}_TOTAL = '${snake}_total';

/**
 * Creates (or fetches) the ${names.kebab} counter.
 *
 * @param services - The service registry to resolve the metrics capability from
 * @returns The counter instrument
 */
export function ${names.camel}Counter(services: IServiceRegistry): ICounter {
  const metrics = services.get<IMetricsService>(CAPABILITIES.METRICS);
  return metrics.counter(${names.screaming}_TOTAL, {
    help: 'Total ${names.kebab} events.',
    labels: ['outcome'],
  });
}
`;
  return [{ path: `src/metrics/${names.kebab}.metric.ts`, contents }];
}
