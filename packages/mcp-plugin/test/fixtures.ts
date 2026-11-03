import { compileTools } from '../src/compile/compile-tools.ts';
import type { McpToolDeclaration } from '../src/options.ts';
import type { RouteDefinition, RouteInfo } from '@setu-ts/common';
export const declaration: McpToolDeclaration = {
  name: 'read',
  description: 'Read an item',
  route: { method: 'GET', path: '/items/:id' },
};
export function tool(
  definition: Partial<RouteDefinition> = {},
  decl: McpToolDeclaration = declaration,
) {
  const route: RouteInfo = {
    method: decl.route.method,
    path: decl.route.path,
    definition: { handler: (ctx) => ctx.response.json({ ok: true }), ...definition },
  };
  return compileTools([decl], [route])[0]!;
}

export const BASE = 'http://localhost';
