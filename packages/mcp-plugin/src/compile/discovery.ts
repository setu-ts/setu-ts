/** Discovers route markers and merges explicit declarations at bootstrap. @module */
import { mcpToolMetadataOf, securityMetadataOf } from '@setu-ts/common';
import type { RouteInfo } from '@setu-ts/common';
import { McpPluginConfigurationError } from '../errors.ts';
import { resolveOptions } from '../options.ts';
import type { McpToolDeclaration, ResolvedOptions } from '../options.ts';

/** Resolves marker identity and refuses ambiguous or unintentionally public tool exposure. */
export function discoverTools(
  routes: readonly RouteInfo[],
  options: ResolvedOptions,
): readonly McpToolDeclaration[] {
  const declarations = [...options.tools];
  for (const route of routes) {
    const label = `${route.method} ${route.path}`;
    const markers = (route.definition.middleware ?? [])
      .map(mcpToolMetadataOf)
      .filter((meta) => meta !== undefined);
    const listed = options.tools.some(
      (tool) => tool.route.method === route.method && tool.route.path === route.path,
    );
    const fail: (message: string) => never = (message) => {
      throw new McpPluginConfigurationError(`${label}: ${message}`);
    };
    if (markers.length > 1) fail('Two MCP markers on one route.');
    if (markers.length > 0 && listed) fail('MCP route is both marked and listed.');
    if (markers.length === 0 && !listed) continue;
    if (
      route.definition.schema?.security === undefined &&
      !(route.definition.middleware ?? []).some((fn) => securityMetadataOf(fn) !== undefined)
    )
      fail('MCP route requires declared security intent.');
    const meta = markers[0];
    if (meta === undefined) continue;
    const method = route.method;
    if (method === 'HEAD' || method === 'OPTIONS') fail('MCP marker method is unsupported.');
    const name = meta.name ?? route.definition.schema?.operationId;
    const description =
      meta.description ?? route.definition.schema?.description ?? route.definition.schema?.summary;
    if (name === undefined || description === undefined) fail('MCP name and description required.');
    try {
      // Construction and discovery share declaration validation, including the name grammar.
      const resolved = resolveOptions({
        path: options.path,
        tools: [{ ...meta, name, description, route: { method, path: route.path } }],
      });
      declarations.push(resolved.tools[0]!);
    } catch (error) {
      if (error instanceof McpPluginConfigurationError) fail(error.message);
      throw error;
    }
  }
  if (declarations.length === 0)
    throw new McpPluginConfigurationError('MCP requires at least one tool at bootstrap.');
  const names = new Set<string>();
  for (const tool of declarations) {
    if (names.has(tool.name))
      throw new McpPluginConfigurationError(
        `${tool.route.method} ${tool.route.path}: Duplicate MCP tool: ${tool.name}`,
      );
    names.add(tool.name);
  }
  return Object.freeze(declarations);
}
