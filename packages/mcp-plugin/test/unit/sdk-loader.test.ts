import { it, expect, vi } from 'vitest';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import { loadSdk } from '../../src/sdk/loader.ts';
it('wraps a failing dynamic import with dependency, requiredBy and cause', async () => {
  vi.doMock('@modelcontextprotocol/server', () => {
    throw new Error('missing SDK');
  });
  try {
    await expect(loadSdk()).rejects.toBeInstanceOf(OptionalDependencyUnavailableError);
    await expect(loadSdk()).rejects.toMatchObject({
      dependency: '@modelcontextprotocol/server',
      cause: expect.any(Error),
    });
    await expect(loadSdk()).rejects.toThrow('@setu-ts/mcp-plugin');
  } finally {
    vi.doUnmock('@modelcontextprotocol/server');
  }
});
