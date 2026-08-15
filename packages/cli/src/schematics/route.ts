/**
 * Route schematic — the imperative escape hatch, in both generator modes.
 *
 * Since M70h this writes into `src/controllers/` alongside the controllers
 * rather than into a parallel `src/routes/` directory. The `.routes.ts` suffix
 * is what distinguishes it, which is the right altitude: it needed a
 * distinguishing NAME, never its own directory.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { FUNCTIONAL_ROUTES_SEAM, HTTP_SEAM_DIR, ROUTES_SEAM } from '../seams/http.ts';
import { seamNames } from '../seams/seam-spec.ts';
import { generatorMode } from '../utils/generator-mode.ts';
import { renderHttpModule } from './http-module.ts';

/**
 * Generates a route module and regenerates the shared HTTP barrel.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the artifacts already present, for the barrel
 * @returns The route module at `src/controllers/<kebab>.routes.ts`, plus the
 *   managed `src/controllers/index.ts` barrel
 */
export function generateRoute(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const seam = generatorMode(options.plugins) === 'class-based'
    ? ROUTES_SEAM
    : FUNCTIONAL_ROUTES_SEAM;

  return [
    {
      path: `${HTTP_SEAM_DIR}/${names.kebab}.routes.ts`,
      contents: renderHttpModule(names, 'routes'),
    },
    {
      path: seam.barrel,
      // Both kinds, for the reason the controller schematic gives: one barrel
      // carries the whole directory, so rendering it from one list would drop
      // the other kind.
      contents: seam.renderBarrel({
        controller: seamNames(options.artifacts, 'controller'),
        route: seamNames(options.artifacts, 'route', names.kebab),
      }),
      managed: true,
    },
  ];
}
