import { describe, it, expect } from 'vitest';
import { harness } from '../fixtures/harness.ts';
describe('tenant isolation', () => {
  it('returns identical 404s for missing and cross-tenant actions', async () => {
    const h = await harness();
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      await h.settle();
      for (const id of [runId, 'missing'])
        for (const call of [
          () => h.service.get(h.ctx('other'), id),
          () => h.service.respond(h.ctx('other'), id),
          () => h.service.cancel(h.ctx('other'), id),
          () => h.service.decide(h.ctx('other'), id, 'approval', { approved: true }),
        ])
          await expect(call()).rejects.toMatchObject({
            name: 'AgentRunNotFoundError',
            message: 'Agent run not found.',
          });
      const noTenant = await h.service.start(h.ctx('', ''), 'demo', { messages: [] });
      await h.settle();
      expect((await h.service.get(h.ctx('', ''), noTenant.runId)).status).toBe('completed');
      await expect(h.service.get(h.ctx(), noTenant.runId)).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
});
