/**
 * Metric schematic — generates metric registration code (gated on metrics-plugin).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a metric file.
 */
export function generateMetric(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const fileName = `src/metrics/${names.kebab}.metric.ts`;
  const contents =
    `import { Counter } from '@hono-enterprise/common';\n\nexport function register${names.pascal}Metric(counter: Counter) {\n  counter.increment();\n}\n`;
  return [{ path: fileName, contents }];
}
