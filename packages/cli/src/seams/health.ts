/**
 * The health-indicator seam.
 *
 * The one family whose registration site the ROADMAP described correctly:
 * `HealthPluginOptions.indicators` already exists, already takes INSTANCES of
 * `IHealthIndicator`, and the plugin registers each at `register()` time. The
 * emitted class implements exactly that interface with a no-argument constructor,
 * so the barrel entry is a plain `new`.
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

/** Barrel export naming every generated health indicator. */
export const HEALTH_INDICATORS_EXPORT = 'HEALTH_INDICATORS';

/**
 * Renders `src/health/index.ts`.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderHealthBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'health-indicator');
  const header = seamHeader('setu generate health-indicator', [
    `HealthPlugin({ indicators: [...${HEALTH_INDICATORS_EXPORT}] })`,
  ]);
  const imports = [
    `import type { IHealthIndicator } from '@setu-ts/common';`,
    renderSeamImports(
      names,
      (n) => `${n.pascal}HealthIndicator`,
      (kebab) => `./${kebab}.indicator.ts`,
    ),
  ].filter((line) => line !== '').join('\n\n');

  // Instances, not constructors: `HealthPluginOptions.indicators` is
  // `readonly IHealthIndicator[]` and the plugin reads `.name` and binds `.check`
  // off each entry, so a class would fail to satisfy the option's own type.
  const entries = names.map((name) => `new ${deriveNames(name).pascal}HealthIndicator()`);

  return assembleSeamBarrel(header, imports, [
    `/** Every generated health indicator, for \`HealthPlugin({ indicators })\`. */\n` +
    `export const ${HEALTH_INDICATORS_EXPORT}: readonly IHealthIndicator[] = [${
      renderList(entries)
    }];`,
  ]);
}

/** The health-indicator seam. */
export const HEALTH_SEAM: SeamSpec = {
  schematic: 'health-indicator',
  dir: 'src/health',
  suffix: '.indicator.ts',
  barrel: 'src/health/index.ts',
  exports: [HEALTH_INDICATORS_EXPORT],
  requiresPlugin: 'health-plugin',
  renderBarrel: renderHealthBarrel,
};
