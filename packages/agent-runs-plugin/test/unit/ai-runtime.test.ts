import { describe, it, expect, vi } from 'vitest';
describe('guarded AI loader', () => {
  it('names the missing peer and loading package and keeps cause', async () => {
    vi.doMock('ai', () => {
      throw new Error('load failed');
    });
    try {
      const { loadAi } = await import('../../src/runtime/ai-runtime.ts');
      await expect(loadAi()).rejects.toMatchObject({
        name: 'OptionalDependencyUnavailableError',
        dependency: 'ai',
        cause: expect.any(Error),
      });
      await expect(loadAi()).rejects.toThrow('@setu-ts/agent-runs-plugin');
    } finally {
      vi.doUnmock('ai');
      vi.resetModules();
    }
  });
});
