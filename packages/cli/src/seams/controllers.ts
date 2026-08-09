/**
 * The standalone-controller seam.
 *
 * `setu generate controller` emits a `@Controller` class outside any domain module,
 * so the M58 module barrel does not carry it. Before this seam a developer had to
 * add both the import and the `controllers` entry to `setu.config.ts` by hand — the
 * M58 e2e proves it, because its own standalone-controller test patches the config
 * to make the class reachable.
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

/** Barrel export naming every generated standalone controller. */
export const APP_CONTROLLERS_EXPORT = 'APP_CONTROLLERS';

/**
 * Symbols the barrel imports from one controller module.
 *
 * @param names - The artifact's derived naming forms
 * @returns The symbols to import
 */
function importSymbols(names: DerivedNames): readonly string[] {
  return [`${names.pascal}Controller`];
}

/**
 * Renders `src/controllers/index.ts`.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderControllersBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'controller');
  const header = seamHeader('setu generate controller', [
    `DecoratorPlugin({ controllers: [...${APP_CONTROLLERS_EXPORT}] })`,
  ]);
  const imports = [
    `import type { Constructor } from '@setu-ts/common';`,
    renderSeamImports(names, importSymbols, (kebab) => `./${kebab}.controller.ts`),
  ].filter((line) => line !== '').join('\n\n');

  const entries = names.map((name) => `${deriveNames(name).pascal}Controller`);

  return assembleSeamBarrel(header, imports, [
    `/** Every generated standalone controller, for \`DecoratorPlugin({ controllers })\`. */\n` +
    `export const ${APP_CONTROLLERS_EXPORT}: readonly Constructor[] = [${renderList(entries)}];`,
  ]);
}

/** The standalone-controller seam. */
export const CONTROLLERS_SEAM: SeamSpec = {
  schematic: 'controller',
  dir: 'src/controllers',
  suffix: '.controller.ts',
  importSymbols,
  barrel: 'src/controllers/index.ts',
  exports: [APP_CONTROLLERS_EXPORT],
  requiresPlugin: 'decorator-plugin',
  renderBarrel: renderControllersBarrel,
};
