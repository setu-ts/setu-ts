/**
 * Route schematic: `setu g route` always writes a function controller.
 *
 * A function controller exports `register<Pascal>Routes(router, services)` and
 * can express what `@Controller` cannot, such as a wildcard, a proxy or a route
 * table built in a loop. It lives in the one controller family, so it shares the
 * `.controller.ts` suffix and the barrel with class controllers.
 *
 * @module
 */
import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { generateController } from './controller.ts';

/**
 * Generates a function controller and regenerates the barrel or module index.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the artifacts already present, for the barrel
 * @returns The controller file plus its managed registration file
 */
export function generateRoute(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  return generateController(names, options, 'function');
}
