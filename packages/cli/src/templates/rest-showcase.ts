/**
 * A worked functional example for the default REST template.
 *
 * A fresh project starts flat, so the example is a function controller in
 * `src/controllers/` and a plain service in `src/services/`, exactly where
 * `setu g controller` and `setu g service` write. It is seeded into both
 * barrels, so `registerGeneratedRoutes` registers it, and it moves into a
 * module with `setu g module <name> --adopt-controllers`.
 *
 * @module
 */
import type { GeneratedFile } from '../utils/file-writer.ts';
import { routeRegistrarSymbol } from '../seams/http.ts';
import { functionalServiceSymbol } from '../seams/services.ts';
import { deriveNames } from '../utils/names.ts';

/** The artifact name shared by the greeting controller and service. */
export const REST_SHOWCASE = 'greeting';

const NAMES = deriveNames(REST_SHOWCASE);
// The functional services barrel admits a file by this export.
const SERVICE = functionalServiceSymbol(NAMES);
const REGISTER = routeRegistrarSymbol(NAMES);

const SERVICE_SOURCE = `/**
 * Builds a greeting for one name.
 *
 * @param name - The name to greet
 * @returns A greeting message
 */
export function ${SERVICE}(name = 'world'): string {
  return \`Hello, \${name}!\`;
}
`;

const CONTROLLER_SOURCE = `import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';

import { ${SERVICE} } from '../services/${NAMES.kebab}.service.ts';

/**
 * Registers the greeting routes: a function controller.
 *
 * @param router - The application router
 */
export function ${REGISTER}(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  router.group('/greetings', (routes) => {
    routes.get('/', (ctx) => ctx.response.json({ message: ${SERVICE}() }));
    routes.get(
      '/:name',
      (ctx) => ctx.response.json({ message: ${SERVICE}(ctx.params.name) }),
    );
  });
}
`;

/** The functional service and controller source emitted by the REST template. */
export const REST_SHOWCASE_FILES: readonly GeneratedFile[] = [
  { path: `src/services/${NAMES.kebab}.service.ts`, contents: SERVICE_SOURCE },
  { path: `src/controllers/${NAMES.kebab}.controller.ts`, contents: CONTROLLER_SOURCE },
];
