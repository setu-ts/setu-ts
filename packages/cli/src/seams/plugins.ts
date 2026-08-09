/**
 * The generated-plugin seam.
 *
 * A generated plugin's registration site is the `plugins: [...]` array
 * `createApplication` takes, so this barrel exports an array the config spreads.
 *
 * The `.plugin.ts` suffix is load-bearing. `setu generate plugin` wrote a bare
 * `src/plugins/<name>.ts` before this milestone, and a suffix of `.ts` would admit
 * ANY module a developer put in that directory — the barrel would then import a
 * `<Pascal>Plugin` symbol they never wrote, and their project would fail to compile
 * naming a file they never generated. That is the failure the module scanner guards
 * with its two-required-files rule; a suffix is the cheaper guard for a flat family.
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

/** Barrel export naming every generated plugin, ready to register. */
export const GENERATED_PLUGINS_EXPORT = 'GENERATED_PLUGINS';

/**
 * Renders `src/plugins/index.ts`.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderPluginsBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'plugin');
  const header = seamHeader('setu generate plugin', [
    `createApplication({ plugins: [/* … */, ...${GENERATED_PLUGINS_EXPORT}] })`,
  ]);
  const imports = [
    `import type { IPlugin } from '@setu-ts/common';`,
    renderSeamImports(
      names,
      (n) => `${n.pascal}Plugin`,
      (kebab) => `./${kebab}.plugin.ts`,
    ),
  ].filter((line) => line !== '').join('\n\n');

  const entries = names.map((name) => `${deriveNames(name).pascal}Plugin()`);

  return assembleSeamBarrel(header, imports, [
    `/**\n` +
    ` * Every generated plugin, spread into \`createApplication({ plugins })\`.\n` +
    ` *\n` +
    ` * Array position does not decide registration order: the kernel resolves plugins\n` +
    ` * by their declared \`dependencies\`, and a generated plugin declares none. Delete a\n` +
    ` * plugin's file to stop registering it — this barrel is regenerated from the\n` +
    ` * directory, so removing the entry here alone would not survive.\n` +
    ` */\n` +
    `export const ${GENERATED_PLUGINS_EXPORT}: readonly IPlugin[] = [${renderList(entries)}];`,
  ]);
}

/** The generated-plugin seam. */
export const PLUGINS_SEAM: SeamSpec = {
  schematic: 'plugin',
  dir: 'src/plugins',
  suffix: '.plugin.ts',
  barrel: 'src/plugins/index.ts',
  exports: [GENERATED_PLUGINS_EXPORT],
  renderBarrel: renderPluginsBarrel,
};
