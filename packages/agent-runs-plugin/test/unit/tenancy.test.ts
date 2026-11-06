import { describe, it, expect } from 'vitest';
import { harness, definition } from '../fixtures/harness.ts';
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
  it('limits reads, streams and cancels to the starting principal unless canAccess widens it', async () => {
    const h = await harness();
    try {
      const { runId } = await h.service.start(h.ctx('tenant', 'owner'), 'demo', { messages: [] });
      await h.settle();
      expect((await h.service.get(h.ctx('tenant', 'owner'), runId)).status).toBe('completed');
      for (const call of [
        () => h.service.get(h.ctx('tenant', 'colleague'), runId),
        () => h.service.respond(h.ctx('tenant', 'colleague'), runId),
        () => h.service.cancel(h.ctx('tenant', 'colleague'), runId),
        () => h.service.get(h.ctx('tenant', ''), runId),
      ])
        await expect(call()).rejects.toMatchObject({ name: 'AgentRunNotFoundError' });
      // A run started without a principal is open to its tenant.
      const shared = await h.service.start(h.ctx('tenant', ''), 'demo', { messages: [] });
      await h.settle();
      expect((await h.service.get(h.ctx('tenant', 'anyone'), shared.runId)).status).toBe(
        'completed',
      );
    } finally {
      await h.close();
    }
    const seen: unknown[] = [];
    const open = await harness(
      definition({
        canAccess: (principal, run) => {
          seen.push([principal?.id, run.principalId]);
          return principal?.id === 'auditor';
        },
      }),
    );
    try {
      const { runId } = await open.service.start(open.ctx('tenant', 'owner'), 'demo', {
        messages: [],
      });
      await open.settle();
      expect((await open.service.get(open.ctx('tenant', 'auditor'), runId)).status).toBe(
        'completed',
      );
      await expect(open.service.get(open.ctx('tenant', 'owner'), runId)).rejects.toMatchObject({
        name: 'AgentRunNotFoundError',
      });
      expect(seen).toContainEqual(['auditor', 'owner']);
    } finally {
      await open.close();
    }
  });
});
