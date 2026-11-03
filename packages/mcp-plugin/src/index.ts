/** @module @setu-ts/mcp-plugin
 * Declared routes as Model Context Protocol tools through the kernel pipeline.
 */
export { McpPlugin } from './plugin/mcp-plugin.ts';
export { mcpTool } from './route/mcp-tool.ts';
export type { McpPluginOptions, McpToolDeclaration } from './options.ts';
export { McpPluginConfigurationError } from './errors.ts';
export { VERSION } from './version.ts';
