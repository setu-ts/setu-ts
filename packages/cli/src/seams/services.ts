/**
 * The plain-service seam.
 *
 * `setu generate service` has no framework registration site of its own — a bare
 * class is consumed by whatever imports it. It acquires one only when the project
 * carries `decorator-plugin`, because then the class can be an `@Injectable` whose
 * token resolves from the service registry (or the DI container, when one exists).
 *
 * So this seam is CONDITIONAL: the schematic emits it only when the plugin is
 * detected, and emits today's plain class otherwise. The alternative — emitting
 * `@Injectable` unconditionally — would force the schematic to be gated like
 * `controller`, which refuses in a bare project where `g service` works today.
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
    `export const ${APP_SERVICES_EXPORT}: readonly Constructor[] = [${renderList(entries)}];`,
  ]);
}

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
