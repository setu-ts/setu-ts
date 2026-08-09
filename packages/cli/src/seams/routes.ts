/**
 * The route seam.
 *
 * `setu generate route` already emits `register<X>Routes(router: IRouterApi)`, so its
 * registration site is a CALL rather than a plugin option — which is why this barrel
 * exports a function instead of an array. `createApp()` invokes it with `app.router`.
 *
 * @module
 */

import type { SeamArtifacts, SeamSpec } from './seam-spec.ts';
import { assembleSeamBarrel, renderSeamImports, seamHeader, seamNames } from './seam-spec.ts';
import type { DerivedNames } from '../utils/names.ts';
import { deriveNames } from '../utils/names.ts';

/** Barrel export that registers every generated route module. */
export const REGISTER_ROUTES_EXPORT = 'registerGeneratedRoutes';

/**
 * Symbols the barrel imports from one route module.
 *
 * @param names - The artifact's derived naming forms
 * @returns The symbols to import
 */
function importSymbols(names: DerivedNames): readonly string[] {
  return [`register${names.pascal}Routes`];
}

/**
 * Renders `src/routes/index.ts`.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderRoutesBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'route');
  const header = seamHeader('setu generate route', [
    `${REGISTER_ROUTES_EXPORT}(app.router);`,
  ]);
  const imports = [
    `import type { IRouterApi } from '@setu-ts/common';`,
    renderSeamImports(names, importSymbols, (kebab) => `./${kebab}.routes.ts`),
  ].filter((line) => line !== '').join('\n\n');

  const calls = names.length === 0
    // An empty body still needs the parameter to be used, or the generated project
    // fails `noUnusedParameters` — which the drift gate applies, since it merges this
    // workspace's own compiler options into every scaffolded project it checks.
    ? '  void router;'
    : names.map((name) => `  register${deriveNames(name).pascal}Routes(router);`).join('\n');

  return assembleSeamBarrel(header, imports, [
    `/**\n` +
    ` * Registers every generated route module.\n` +
    ` *\n` +
    ` * @param router - The router to register on, normally \`app.router\`\n` +
    ` */\n` +
    `export function ${REGISTER_ROUTES_EXPORT}(router: IRouterApi): void {\n` +
    `${calls}\n` +
    `}`,
  ]);
}

/** The route seam. */
export const ROUTES_SEAM: SeamSpec = {
  schematic: 'route',
  dir: 'src/routes',
  suffix: '.routes.ts',
  importSymbols,
  barrel: 'src/routes/index.ts',
  exports: [REGISTER_ROUTES_EXPORT],
  renderBarrel: renderRoutesBarrel,
};
