import { describe, it, expect } from 'vitest';
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
});
