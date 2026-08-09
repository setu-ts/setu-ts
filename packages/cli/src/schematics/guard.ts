/**
 * Guard schematic — a short-circuiting route guard (gated on `auth-plugin`).
 *
 * Deliberately NOT wired, and this is a design decision rather than a gap. A guard's
 * positions are all per target — `RouteDefinition.middleware` on one route, or
 * `@UseGuards` on one controller or handler — and `auth-plugin` publishes no guard
 * list a barrel could feed. The only barrel-shaped alternative is the global
 * middleware pipeline, and the emitted guard answers `401` whenever
 * `ctx.request.user` is absent: registering it there would 401 `/health`, `/metrics`
 * and `/`, turning a generated file into an outage. A wiring that must not be applied
 * is not a wiring, so the emitted JSDoc names both real positions instead.
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
 * Apply it PER ROUTE — the CLI does not wire guards, because a guard applied globally
 * would reject unauthenticated requests to \`/health\`, \`/metrics\` and every public
 * route:
 *
 * \`\`\`typescript
 * app.router.get('/reports', {
 *   handler: (ctx) => ctx.response.json({ reports: [] }),
 *   middleware: [require${names.pascal}()],
 * });
 * \`\`\`
 *
 * On a decorated controller, \`@UseGuards(require${names.pascal}())\` is the equivalent,
 * on either the class or one handler.
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
