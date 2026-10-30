/** The function controller body shared by `g controller` and `g route`. @module */
import type { DerivedNames } from '../utils/names.ts';
import { routeRegistrarSymbol } from '../seams/http.ts';

/** Renders a function controller; its filename supplies the exported registrar name. */
export function renderHttpModule(names: DerivedNames, module?: string): string {
  return `import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';

/**
 * Registers the ${names.kebab} routes.
 *
 * A function controller declares its routes directly on the router. Use it for
 * ordinary resources, wildcards, proxies or a route table computed in a loop.
 *
 * Called for you by the managed index in \`${module === undefined ? 'src/controllers' : `src/modules/${module}`}/index.ts\`,
 * which \`setu.config.ts\` invokes with \`app.router\` and \`app.services\` — so this module needs no
 * further wiring. Call it directly with \`ctx.router\` to register these routes
 * from inside a plugin instead.
 *
 * @param router - The router to register on
 * @param services - The application service registry
 */
export function ${routeRegistrarSymbol(names)}(
  router: IRouterApi,
  services?: IServiceRegistry,
): void {
  void services;
  router.group('/${module === undefined ? '' : `${module}/`}${names.kebab}', (routes) => {
    routes.get('/', (ctx) => ctx.response.json({ items: [] }));

    routes.get('/:id', (ctx) => ctx.response.json({ id: ctx.params['id'] }));

    routes.post('/', (ctx) => ctx.response.status(201).json({ created: true }));
  });
}
`;
}
