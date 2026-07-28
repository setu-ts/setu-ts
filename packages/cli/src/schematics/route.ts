/**
 * Route schematic — a route module registering handlers on the router API.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a route registration module.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: routes are runtime-agnostic
 * @returns One file at `src/routes/<kebab>.routes.ts`
 */
export function generateRoute(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import type { IRouterApi } from '@hono-enterprise/common';

/**
 * Registers the ${names.kebab} routes.
 *
 * Pass \`app.router\` from application setup, or \`ctx.router\` from inside a
 * plugin's \`register\`.
 *
 * @param router - The router to register on
 */
export function register${names.pascal}Routes(router: IRouterApi): void {
  router.group('/${names.kebab}', (${names.camel}) => {
    ${names.camel}.get('/', (ctx) => ctx.response.json({ items: [] }));

    ${names.camel}.get('/:id', (ctx) => ctx.response.json({ id: ctx.params['id'] }));

    ${names.camel}.post('/', (ctx) => ctx.response.status(201).json({ created: true }));
  });
}
`;
  return [{ path: `src/routes/${names.kebab}.routes.ts`, contents }];
}
