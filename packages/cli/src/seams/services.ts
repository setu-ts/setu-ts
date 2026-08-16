/**
 * The plain-service seam.
 *
 * `setu generate service` has no framework registration site of its own — a bare
 * class is consumed by whatever imports it. It acquires one only when the project
 * carries `decorator-plugin`, because then the class can be an `@Injectable` whose
 * token resolves from the service registry (or the DI container, when one exists).
 *
 * So this seam is CONDITIONAL: the schematic emits it only when the plugin is
 * detected, and emits a plain exported function otherwise. The alternative — emitting
 * `@Injectable` unconditionally — would force the schematic to be gated like
 * `controller`, which refuses in a bare project where `g service` works today.
 *
 * The functional shape has its own spec, {@linkcode FUNCTIONAL_SERVICES_SEAM}, because
 * a family's spec is what the scanner admits files by as well as what the barrel is
 * rendered from. One shape cannot describe both.
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

/** Barrel export naming every generated standalone service. */
export const APP_SERVICES_EXPORT = 'APP_SERVICES';

/**
 * Symbols the barrel imports from one service module.
 *
 * The class only. A service generated before this seam existed exports exactly that, so
 * it is still admitted — but it carries no `@Injectable`, so `DecoratorPlugin` registers
 * it under its CLASS NAME rather than the `<name>-service` token. The barrel's own
 * comment says so rather than claiming a token that entry does not have.
 *
 * @param names - The artifact's derived naming forms
 * @returns The symbols to import
 */
function importSymbols(names: DerivedNames): readonly string[] {
  return [`${names.pascal}Service`];
}

/**
 * The capability token a generated service registers under.
 *
 * Derived from the artifact name rather than the class name, matching the module
 * schematic, so the token a developer types in `@Inject` is predictable. An explicit
 * token is mandatory because `emitDecoratorMetadata` is unavailable under Deno, so a
 * parameter's type cannot be read.
 *
 * @param kebab - The artifact's kebab-case name
 * @returns The token, e.g. `user-profile-service`
 */
export function serviceSeamToken(kebab: string): string {
  return `${kebab}-service`;
}

/**
 * Renders `src/services/index.ts`.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderServicesBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'service');
  const header = seamHeader('setu generate service', [
    `DecoratorPlugin({ services: [...${APP_SERVICES_EXPORT}] })`,
  ]);
  const imports = [
    `import type { Constructor } from '@setu-ts/common';`,
    renderSeamImports(names, importSymbols, (kebab) => `./${kebab}.service.ts`),
  ].filter((line) => line !== '').join('\n\n');

  const entries = names.map((name) => `${deriveNames(name).pascal}Service`);

  return assembleSeamBarrel(header, imports, [
    `/**\n` +
    ` * Every generated service, for \`DecoratorPlugin({ services })\`.\n` +
    ` *\n` +
    ` * An \`@Injectable\` service registers under its declared \`<name>-service\` token. One\n` +
    ` * generated before this seam existed has no decorator, so it registers under its\n` +
    ` * class name instead — regenerate it to get the token.\n` +
    ` */\n` +
    renderExportedArray(APP_SERVICES_EXPORT, 'Constructor', entries),
  ]);
}

/**
 * The symbol a FUNCTIONAL service module exports.
 *
 * Owned here rather than in the schematic, for the reason
 * {@linkcode SeamSpec.importSymbols} gives: the renderer that names a symbol and the
 * scanner that requires it must read one definition. `schematics/service.ts` renders
 * its function from this, so the two cannot drift.
 *
 * @param names - The artifact's derived naming forms
 * @returns The exported function's name
 */
export function functionalServiceSymbol(names: DerivedNames): string {
  return `describe${names.pascal}`;
}

/**
 * Renders the functional `src/services/index.ts`.
 *
 * A convenience re-export, NOT a registration: a plain function has no framework
 * registration site, no plugin option takes a list of functions, and nothing in the
 * generated `setu.config.ts` imports this file. Its header therefore says how to
 * consume it rather than borrowing {@linkcode seamHeader}, whose text promises a
 * `setu.config.ts` line that does not exist here.
 *
 * The header's example name is FIXED rather than taken from the first real service.
 * This file is managed and rewritten on every `g service`, so a header that varied
 * with the artifact set would churn — deleting the alphabetically-first service would
 * rewrite a comment that has nothing to do with it.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderFunctionalServicesBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'service');
  const header = [
    '// Generated by `setu generate service`.',
    '// The CLI owns this file and rewrites it whenever a service is added, so edits',
    '// here are lost — add them with the CLI.',
    '//',
    '// This is a convenience re-export, not a registration. A plain function has no',
    '// framework registration site, so nothing wires these for you — import from here:',
    '//',
    "//   import { describeThing } from './src/services/index.ts';",
    '',
  ].join('\n');

  // No empty-list arm, deliberately. Unlike the registry seams, this barrel is never
  // scaffolded: it is rendered only by the schematic, which always passes the name it
  // is generating right now, so `names` is never empty. An arm for that case would be
  // a branch no code path takes.
  const body = names
    .map((name) => {
      const derived = deriveNames(name);
      return `export { ${functionalServiceSymbol(derived)} } from './${derived.kebab}.service.ts';`;
    })
    .join('\n');

  return `${header}\n${body}\n`;
}

/**
 * The functional service seam.
 *
 * Deliberately NOT in the seam registry: `templates/seam.ts` derives a host's
 * scaffold-time files and `setu.config.ts` imports from that registry, and this barrel
 * belongs in neither — there is nothing to register. It is selected explicitly, by
 * generator mode, at the two places that need it: the schematic that renders it and the
 * scan that admits its artifacts.
 *
 * That scan is the load-bearing half. `readArtifactNames` requires a file to export
 * every symbol the barrel will import, and the class seam's `importSymbols` names
 * `<Pascal>Service` — so scanning a functional project with the class spec REJECTED
 * every service the CLI had just written, and every later `setu generate` printed
 * `Skipped src/services/x.service.ts: it does not export XService` followed by
 * `Regenerate it to bring it up to date`. Both sentences were false, and the advice
 * looped: regenerating produced the identical file.
 */
export const FUNCTIONAL_SERVICES_SEAM: SeamSpec = {
  schematic: 'service',
  dir: 'src/services',
  suffix: '.service.ts',
  importSymbols: (names) => [functionalServiceSymbol(names)],
  barrel: 'src/services/index.ts',
  // Nothing imports this barrel from `setu.config.ts`, so there is no `LocalImport`
  // to derive. Empty is the honest value, not a placeholder.
  exports: [],
  renderBarrel: renderFunctionalServicesBarrel,
};

/** The plain-service seam. */
export const SERVICES_SEAM: SeamSpec = {
  schematic: 'service',
  dir: 'src/services',
  suffix: '.service.ts',
  importSymbols,
  barrel: 'src/services/index.ts',
  exports: [APP_SERVICES_EXPORT],
  requiresPlugin: 'decorator-plugin',
  renderBarrel: renderServicesBarrel,
};
