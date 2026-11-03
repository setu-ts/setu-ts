/** Functional route opt-in for MCP discovery. @module */
import type { MiddlewareFunction, RouteMcpToolMetadata } from '@setu-ts/common';
import { withMcpToolMetadata } from '@setu-ts/common';

/**
 * Marks a route as an MCP tool without changing its request behavior.
 * @param meta - Tool identity and retry safety; identity defaults to route schema metadata
 * @returns A branded pass-through middleware
 * @example
 * ```typescript
 * mcpTool({ name: 'read_order', description: 'Read an order' });
 * ```
 * @since 0.13.0
 */
export function mcpTool(meta: RouteMcpToolMetadata = {}): MiddlewareFunction {
  return withMcpToolMetadata((_ctx, next) => next(), meta);
}
