/**
 * Guard schematic — a short-circuiting route guard (gated on `auth-plugin`).
 *
 * Guards compose auth-plugin's permission middleware. Registration remains per
 * route or decorated handler: applying one globally would reject public routes.
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
import { requirePermission } from '@setu-ts/auth-plugin';

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
  return requirePermission('${names.kebab}');
}
`;
  return [{ path: `src/guards/${names.kebab}.guard.ts`, contents }];
}
