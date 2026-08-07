/**
 * Middleware schematic — a middleware factory.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a middleware factory.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: middleware is runtime-agnostic
 * @returns One file at `src/middleware/<kebab>.middleware.ts`
 */
export function generateMiddleware(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import type { MiddlewareFunction } from '@setu-ts/common';

/**
 * Creates the ${names.kebab} middleware.
 *
 * Add it with \`app.middleware.add(${names.camel}Middleware())\` or, from a
 * plugin, \`ctx.middleware.add(${names.camel}Middleware())\`.
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
  return [{ path: `src/middleware/${names.kebab}.middleware.ts`, contents }];
}
