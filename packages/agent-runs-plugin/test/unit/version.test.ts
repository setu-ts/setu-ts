import { describe, it, expect, vi } from 'vitest';
import { AgentRunService } from '../../src/service/agent-run-service.ts';
import { harness, row, definition, fakeAi } from '../fixtures/harness.ts';
describe('definition versions', () => {
  for (const [version, name, compatible] of [
    ['old', 'demo', false],
    ['1', 'missing', false],
    ['old', 'demo', true],
  ] as const)
    it(`resumes ${name}/${version} compatible=${compatible}`, async () => {
      const ai = fakeAi();
      const h = await harness(definition(compatible ? { compatibleVersions: ['old'] } : {}), ai);
      try {
        await h.store.create(row({ version, definition: name }));
        await h.service.resume((await h.store.get('run'))!);
        await h.settle();
        expect((await h.store.get('run'))?.status).toBe(compatible ? 'completed' : 'failed');
        expect(ai.model).toHaveBeenCalledTimes(compatible ? 1 : 0);
      } finally {
        await h.close();
      }
    });
  it('logs a version-incompatible failure at warn (fix review F6)', async () => {
    const h = await harness();
    const warn = vi.fn();
    const service = new AgentRunService({
      ...h.deps,
      logger: { warn } as unknown as import('@setu-ts/common').ILogger,
    });
    try {
      await h.store.create(row({ version: 'old' }));
      await service.resume((await h.store.get('run'))!);
      while (service.work.size) await Promise.all([...service.work]);
      expect((await h.store.get('run'))?.error).toBe('version-incompatible');
      expect(warn).toHaveBeenCalledWith('Agent run failed.', {
        definition: 'demo',
        error: 'version-incompatible',
      });
    } finally {
      service.close();
      await h.close();
    }
  });
});
