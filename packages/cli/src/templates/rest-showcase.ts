/**
 * A worked functional example for the default REST template.
 *
 * The example is registered through the controller seam and reaches its plain
 * service by a direct import, exactly as the functional generators do.
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
const SERVICE = functionalServiceSymbol(NAMES);
const REGISTER = routeRegistrarSymbol(NAMES);

const SERVICE_SOURCE = `/**
 * Builds a greeting for one name.
 *
 * @param name - The name to greet
 * @returns A greeting message
 */
export function ${SERVICE}(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

const CONTROLLER_SOURCE = `import type { IRouterApi } from '@setu-ts/common';

import { ${SERVICE} } from '../services/${NAMES.kebab}.service.ts';

/**
 * Registers the greeting routes.
 *
 * @param router - The application router
 */
export function ${REGISTER}(router: IRouterApi): void {
  router.group('/greetings', (routes) => {
    routes.get('/', (ctx) => ctx.response.json({ message: ${SERVICE}('world') }));
    routes.get(
      '/:name',
      (ctx) => ctx.response.json({ message: ${SERVICE}(ctx.params.name ?? 'world') }),
    );
  });
}
`;

/** The functional service and controller source emitted by the REST template. */
export const REST_SHOWCASE_FILES: readonly GeneratedFile[] = [
  { path: `src/services/${NAMES.kebab}.service.ts`, contents: SERVICE_SOURCE },
  { path: `src/controllers/${NAMES.kebab}.controller.ts`, contents: CONTROLLER_SOURCE },
];
