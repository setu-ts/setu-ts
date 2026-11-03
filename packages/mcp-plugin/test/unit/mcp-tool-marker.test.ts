import { it, expect, vi } from 'vitest';
import { mcpToolMetadataOf } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';
import { mcpTool } from '../../src/index.ts';

it.each([
  undefined,
  { name: 'read', description: 'Read', title: 'Item', repeatable: true },
] as const)('passes through once and carries metadata %j', async (meta) => {
  const middleware = mcpTool(meta);
  const next = vi.fn(() => Promise.resolve());
  await middleware(createTestContext(), next);
  expect(next).toHaveBeenCalledOnce();
  expect(mcpToolMetadataOf(middleware)).toEqual(meta ?? {});
});
