/**
 * Middleware schematic — a middleware factory and its pipeline position.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import {
  GENERATED_MIDDLEWARE_EXPORT,
  MIDDLEWARE_SEAM,
  middlewarePriorityExport,
} from '../seams/middleware.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * The pipeline position a generated middleware starts at.
 *
 * `500` is the kernel's own default, so the emitted value reorders nothing: a
 * generated middleware lands exactly where a bare `app.middleware.add(fn())` would
 * have put it. It is emitted EXPLICITLY rather than left to that default because the
 * seam barrel has to pass a number, and a silent default is how a scaffolded project
 * once ended up with an error handler that could not catch a metrics throw.
 */
const DEFAULT_PRIORITY = 500;

/**
 * Generates a middleware factory and regenerates the seam barrel that adds it.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the middleware already present, for the barrel
 * @returns The middleware at `src/middleware/<kebab>.middleware.ts`, plus the managed
 *   `src/middleware/index.ts` barrel
 */
export function generateMiddleware(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const priorityConst = middlewarePriorityExport(names.screaming);
  const contents = `import type { MiddlewareFunction } from '@setu-ts/common';

/**
 * Where this middleware sits in the pipeline. Lower runs earlier, so lower is
 * outermost; \`500\` is the framework default.
 *
 * Change it HERE, not in \`src/middleware/index.ts\` — the CLI regenerates that barrel
 * from this constant, so an edit there is lost on the next generate. For reference,
 * the framework's own middleware occupy 0 (error handler), 20 (metrics),
 * 30 (telemetry), 120–275 (security), so a value below 20 runs outside all of them.
 */
export const ${priorityConst} = ${DEFAULT_PRIORITY};

/**
 * Creates the ${names.kebab} middleware.
 *
 * Added for you through the \`${GENERATED_MIDDLEWARE_EXPORT}\` barrel in
 * \`src/middleware/index.ts\`, which \`setu.config.ts\` walks — so this module needs no
 * further wiring. Call \`${names.camel}Middleware()\` directly to add it to one route's
 * \`middleware\` list, or from a plugin's \`ctx.middleware.add(...)\`.
 *
 * @returns The middleware function
 */
export function ${names.camel}Middleware(): MiddlewareFunction {
  return async (ctx, next) => {
    // Runs before the handler.
    await next();
    // Runs after the handler; short-circuit by returning without calling next().
    ctx.response.header('X-${names.pascal}', 'true');
  };
}
`;
  return [
    { path: `src/middleware/${names.kebab}.middleware.ts`, contents },
    {
      path: MIDDLEWARE_SEAM.barrel,
      contents: MIDDLEWARE_SEAM.renderBarrel({
        middleware: seamNames(options.artifacts, 'middleware', names.kebab),
      }),
      managed: true,
    },
  ];
}
