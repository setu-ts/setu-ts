import { describe, it, expect, vi } from 'vitest';
import { MCP_TOOL_METADATA, mcpToolMetadataOf, withMcpToolMetadata } from '../../src/index.ts';
import type { MiddlewareFunction, RouteMcpToolMetadata } from '../../src/index.ts';

describe('MCP tool metadata', () => {
  it.each([
    {},
    { name: 'read', description: 'Read', title: 'Read item', repeatable: true },
  ] as const)(
    'preserves identity and behavior with non-enumerable metadata %j',
    async (metadata: RouteMcpToolMetadata) => {
      const fn: MiddlewareFunction = (_ctx, next) => next();
      expect(withMcpToolMetadata(fn, metadata)).toBe(fn);
      expect(mcpToolMetadataOf(fn)).toBe(metadata);
      expect(MCP_TOOL_METADATA).toBe(Symbol.for('setu.mcp-tool.metadata'));
      expect(Object.keys(fn)).toEqual([]);
      expect(Object.getOwnPropertyDescriptor(fn, MCP_TOOL_METADATA)).toEqual({
        value: metadata,
        enumerable: false,
        configurable: true,
        writable: false,
      });
      const next = vi.fn(() => Promise.resolve());
      await fn({} as Parameters<MiddlewareFunction>[0], next);
      expect(next).toHaveBeenCalledOnce();
    },
  );
  it.each([
    undefined,
    null,
    1,
    'tool',
    true,
    [],
    { name: 1 },
    { name: null },
    { description: 1 },
    { description: null },
    { title: 1 },
    { title: null },
    { repeatable: false },
    { repeatable: 1 },
  ])('reads forged or ill-typed metadata %j as absent', (value) => {
    const fn: MiddlewareFunction = () => {};
    Object.defineProperty(fn, MCP_TOOL_METADATA, { value });
    expect(mcpToolMetadataOf(fn)).toBeUndefined();
  });
  it('reads an unbranded middleware as absent', () => {
    expect(mcpToolMetadataOf(() => {})).toBeUndefined();
  });
});
