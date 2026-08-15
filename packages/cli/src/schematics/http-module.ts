/**
 * The imperative HTTP module body, shared by two schematics.
 *
 * A functional `g controller` and a `g route` both emit a module exporting
 * `register<Name>Routes(router)`. They differ in filename suffix and in the
 * JSDoc that frames them — not in the code — so the body lives here rather than
 * being copied into both schematics (AI_GUIDELINES §11.1).
 *
 * @module
 */

import type { DerivedNames } from '../utils/names.ts';
import { routeRegistrarSymbol } from '../seams/http.ts';

/**
 * Which of the two imperative kinds is being generated.
 *
 * The distinction is real even though the emitted body is identical: a
 * functional controller is the mode-default shape for a resource, while a
 * `.routes.ts` module is the escape hatch a `@Controller` cannot express —
 * wildcards, proxies, and route tables computed in a loop.
 */
export type HttpModuleKind = 'controller' | 'routes';

/**
 * Renders an imperative route-registration module.
 *
 * The group callback's parameter is the fixed identifier `routes`, never the
 * derived name: a resource legitimately called `class` (or `new`, `for`, …)
 * would otherwise be interpolated into a binding position and emit source that
 * does not parse.
 *
 * @param names - Naming forms derived from the user's input
 * @param kind - Which imperative kind this module is
 * @returns The module contents
 */
export function renderHttpModule(names: DerivedNames, kind: HttpModuleKind): string {
  const framing = kind === 'controller'
    ? ` * This project has no \`decorator-plugin\`, so a controller is a function that\n` +
      ` * registers its own routes. Install the plugin and regenerate to get the\n` +
      ` * decorated class form instead.\n`
    : ` * A \`.routes.ts\` module is the imperative escape hatch, and stays correct in\n` +
      ` * both generator modes: a \`@Controller\` has no wildcard decorator and cannot\n` +
      ` * compute routes in a loop, so a proxy or a computed route table belongs here.\n`;

  return `import type { IRouterApi } from '@setu-ts/common';

/**
 * Registers the ${names.kebab} routes.
 *
${framing} *
 * Called for you by \`registerGeneratedRoutes\` in \`src/controllers/index.ts\`,
 * which \`setu.config.ts\` invokes with \`app.router\` — so this module needs no
 * further wiring. Call it directly with \`ctx.router\` to register these routes
 * from inside a plugin instead.
 *
 * @param router - The router to register on
 */
export function ${routeRegistrarSymbol(names)}(router: IRouterApi): void {
  router.group('/${names.kebab}', (routes) => {
    routes.get('/', (ctx) => ctx.response.json({ items: [] }));

    routes.get('/:id', (ctx) => ctx.response.json({ id: ctx.params['id'] }));

    routes.post('/', (ctx) => ctx.response.status(201).json({ created: true }));
  });
}
`;
}
