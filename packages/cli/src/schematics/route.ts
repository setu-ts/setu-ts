/**
 * Route schematic — a route module registering handlers on the router API.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { REGISTER_ROUTES_EXPORT, ROUTES_SEAM } from '../seams/routes.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * Generates a route registration module and regenerates the seam barrel that calls it.
 *
 * The group callback's parameter is the fixed identifier `routes`, never the
 * derived name: a resource legitimately called `class` (or `new`, `for`, …)
 * would otherwise be interpolated into a binding position and emit source that
 * does not parse.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the route modules already present, for the barrel
 * @returns The route module at `src/routes/<kebab>.routes.ts`, plus the managed
 *   `src/routes/index.ts` barrel
 */
export function generateRoute(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import type { IRouterApi } from '@setu-ts/common';

/**
 * Registers the ${names.kebab} routes.
 *
 * Called for you by \`${REGISTER_ROUTES_EXPORT}\` in \`src/routes/index.ts\`, which
 * \`setu.config.ts\` invokes with \`app.router\` — so this module needs no further
 * wiring. Call it directly with \`ctx.router\` to register these routes from inside a
 * plugin instead.
 *
 * @param router - The router to register on
 */
export function register${names.pascal}Routes(router: IRouterApi): void {
  router.group('/${names.kebab}', (routes) => {
    routes.get('/', (ctx) => ctx.response.json({ items: [] }));

    routes.get('/:id', (ctx) => ctx.response.json({ id: ctx.params['id'] }));

    routes.post('/', (ctx) => ctx.response.status(201).json({ created: true }));
  });
}
`;
  return [
    { path: `src/routes/${names.kebab}.routes.ts`, contents },
    {
      path: ROUTES_SEAM.barrel,
      contents: ROUTES_SEAM.renderBarrel({
        route: seamNames(options.artifacts, 'route', names.kebab),
      }),
      managed: true,
    },
  ];
}
