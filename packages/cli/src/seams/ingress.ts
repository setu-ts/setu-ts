/**
 * Decorated non-HTTP ingress seam.
 *
 * A class-based application gives this one barrel to `DecoratorPlugin({ ingress })`.
 * The generated artifacts are deliberately absent from the functional seams: registering
 * an event or CQRS handler through both paths would deliver each message twice.
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

/** Barrel export consumed by `DecoratorPlugin({ ingress })`. */
export const INGRESS_HANDLERS_EXPORT = 'INGRESS_HANDLERS';

function importSymbols(names: DerivedNames): readonly string[] {
  return [`${names.pascal}Ingress`];
}

function modulePath(schematic: string, kebab: string): string {
  return `./${kebab}.${schematic}.ts`;
}

/** Renders the shared ingress barrel from every class-based ingress artifact. */
function renderIngressBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'ingress');
  const imports = renderSeamImports(names, importSymbols, (kebab) => modulePath('ingress', kebab));
  const classes = names.map((name) =>
    `${name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}Ingress`
  );

  return assembleSeamBarrel(
    seamHeader('setu generate job / ws-route / event-handler / command-handler / query-handler', [
      `DecoratorPlugin({ ingress: [...${INGRESS_HANDLERS_EXPORT}] })`,
    ]),
    [
      `import type { Constructor } from '@setu-ts/common';`,
      imports,
    ].filter((line) => line !== '').join('\n\n'),
    [
      `/** Every generated decorated ingress class. */\n` +
      renderExportedArray(INGRESS_HANDLERS_EXPORT, 'Constructor', classes),
    ],
  );
}

/** The one class-based registration seam for every non-HTTP ingress artifact. */
export const INGRESS_SEAM: SeamSpec = {
  schematic: 'ingress',
  dir: 'src/ingress',
  suffix: '.ingress.ts',
  importSymbols,
  barrel: 'src/ingress/index.ts',
  exports: [INGRESS_HANDLERS_EXPORT],
  requiresPlugin: 'decorator-plugin',
  renderBarrel: renderIngressBarrel,
};
