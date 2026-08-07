/**
 * Guard schematic — a short-circuiting route guard (gated on `auth-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a route guard.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: guards are runtime-agnostic
 * @returns One file at `src/guards/<kebab>.guard.ts`
 */
export function generateGuard(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import type { MiddlewareFunction } from '@setu-ts/common';

/**
 * Guards a route behind the ${names.kebab} check.
 *
 * The guard short-circuits by responding WITHOUT calling \`next()\`, so the
 * handler never runs when the check fails.
 *
 * @returns The guard middleware
 */
export function require${names.pascal}(): MiddlewareFunction {
  return async (ctx, next) => {
    const user = ctx.request.user;
    if (!user) {
      ctx.response.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Replace with the real ${names.kebab} check.
    const allowed = true;
    if (!allowed) {
      ctx.response.status(403).json({ error: 'Forbidden' });
      return;
    }

    await next();
  };
}
`;
  return [{ path: `src/guards/${names.kebab}.guard.ts`, contents }];
}
