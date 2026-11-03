/** Method-level MCP tool declarations. @module */
import '../metadata/symbol-metadata.ts';
import type { RouteMcpToolMetadata } from '@setu-ts/common';
import { methodDecorator } from '../metadata/context-bridge.ts';
import type { SetuMethodDecorator } from '../metadata/context-bridge.ts';

/**
 * Marks a controller method as an MCP tool; discovery is supplied by the MCP plugin.
 * @param meta - Tool identity and retry safety; name defaults to operationId, then method name
 * @returns A standard method decorator
 * @throws {TypeError} If applied outside a method
 * @example
 * ```typescript
 * @Get('/')
 * @McpTool({ description: 'List orders' })
 * list() { return this.orders.list(); }
 * ```
 * @since 0.13.0
 */
export function McpTool(meta: RouteMcpToolMetadata = {}): SetuMethodDecorator {
  const decorate = methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (method) => {
      method.mcpTool = meta;
    });
  });
  return (value, context): void => {
    if (context.kind !== 'method') throw new TypeError('@McpTool requires a method.');
    decorate(value, context);
  };
}
