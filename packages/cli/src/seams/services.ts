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
import { deriveNames } from '../utils/names.ts';

/** Barrel export naming every generated standalone service. */
export const APP_SERVICES_EXPORT = 'APP_SERVICES';

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
    renderSeamImports(
      names,
      (n) => `${n.pascal}Service`,
      (kebab) => `./${kebab}.service.ts`,
    ),
  ].filter((line) => line !== '').join('\n\n');

  const entries = names.map((name) => `${deriveNames(name).pascal}Service`);

  return assembleSeamBarrel(header, imports, [
    `/** Every generated service, for \`DecoratorPlugin({ services })\`. Each registers\n` +
    ` * under the token \`<name>-service\`. */\n` +
    `export const ${APP_SERVICES_EXPORT}: readonly Constructor[] = [${renderList(entries)}];`,
  ]);
}

/** The plain-service seam. */
export const SERVICES_SEAM: SeamSpec = {
  schematic: 'service',
  dir: 'src/services',
  suffix: '.service.ts',
  barrel: 'src/services/index.ts',
  exports: [APP_SERVICES_EXPORT],
  requiresPlugin: 'decorator-plugin',
  renderBarrel: renderServicesBarrel,
};
