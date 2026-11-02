import { it, expect } from 'vitest';
import * as barrel from '../../src/index.ts';
import type { McpPluginOptions, McpToolDeclaration } from '../../src/index.ts';
import { declaration } from '../fixtures.ts';
it('exports exactly the approved runtime surface and declaration types', () => {
  expect(Object.keys(barrel).sort()).toEqual([
    'McpPlugin',
    'McpPluginConfigurationError',
    'VERSION',
  ]);
  const tool: McpToolDeclaration = declaration;
  const options: McpPluginOptions = { tools: [tool] };
  expect(barrel.McpPlugin(options).name).toBe('mcp');
  expect(barrel.VERSION).toBe('0.11.0');
});
