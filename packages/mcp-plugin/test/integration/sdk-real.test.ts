import { it, expect } from 'vitest';
import { loadSdk } from '../../src/sdk/loader.ts';
let installed = true;
try {
  await import('@modelcontextprotocol/server');
} catch {
  installed = false;
}
it.skipIf(!installed)('loads the real SDK', async () => {
  const sdk = await loadSdk();
  expect(typeof sdk.McpServer).toBe('function');
  expect(typeof sdk.createMcpHandler).toBe('function');
});

it.skipIf(!installed)(
  'resolves the guarded SDK import for the workerd bundle condition',
  async () => {
    const { build } = await import('esbuild');
    const { resolve } = await import('node:path');
    const result = await build({
      entryPoints: ['packages/mcp-plugin/src/index.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd'],
      alias: { '@setu-ts/common': resolve('packages/common/src/index.ts') },
    });
    expect(result.errors).toEqual([]);
    expect(result.outputFiles[0]?.text).toContain('McpPlugin');
  },
);
