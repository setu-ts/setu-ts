/* eslint-disable require-await -- Fakes preserve asynchronous provider and tool contracts. */
import { describe, it, expect, vi } from 'vitest';
import { jsonSchema } from 'ai';
import { harness, definition, fakeAi, row } from '../fixtures/harness.ts';
import { sweep } from '../../src/sweep/sweep.ts';
import { AgentRunLeaseLostError } from '@setu-ts/common';
describe('bounded sweep', () => {
  it('handles concurrent decisions, missing runs, pending peers and transition races', async () => {
    const h = await harness();
    try {
      const a = {
        id: 'a',
        runId: 'run',
        tenantId: 'tenant',
        seq: 0,
        toolCallId: 'c',
        toolName: 't',
        input: null,
        status: 'pending' as const,
        deadline: 1,
        decidedBy: null,
        decidedAt: null,
        reason: null,
      };
      vi.spyOn(h.store, 'expired').mockResolvedValue([a]);
      const decide = vi.spyOn(h.store, 'decide').mockResolvedValue(null);
      const get = vi.spyOn(h.store, 'get').mockResolvedValue(null);
      vi.spyOn(h.store, 'resumable').mockResolvedValue([]);
      vi.spyOn(h.store, 'terminal').mockResolvedValue([{ ...row(), status: 'completed' }]);
      vi.spyOn(h.store, 'purge').mockResolvedValue(false);
      const options = { now: 100, sweepBatch: 5, maxClockSkewMs: 0, retentionMs: 1 };
      const resume = () => Promise.resolve(false);
      expect((await sweep(h.store, options, resume)).expired).toBe(0);
      decide.mockResolvedValue({ ...a, status: 'expired' });
      expect((await sweep(h.store, options, resume)).expired).toBe(1);
      get.mockResolvedValue({ ...row(), status: 'waiting' });
      const approvals = vi.spyOn(h.store, 'approvals').mockResolvedValue([a]);
      await sweep(h.store, options, resume);
      approvals.mockResolvedValue([]);
      const update = vi.spyOn(h.store, 'update').mockRejectedValue(new AgentRunLeaseLostError());
      await expect(sweep(h.store, options, resume)).resolves.toMatchObject({ expired: 1 });
      update.mockRejectedValue(new Error('store'));
      await expect(sweep(h.store, options, resume)).rejects.toThrow('store');
    } finally {
      await h.close();
    }
  });
  it('expires approvals across a restart, resumes denial and purges children (G3)', async () => {
    const execute = vi.fn();
    const ai = fakeAi([
      {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'act', input: {} }],
          },
        ],
        finishReason: 'tool-calls',
        usage: {},
      },
    ]);
    const h = await harness(
      definition({
        tools: { act: { inputSchema: jsonSchema({}), execute } },
        approval: { tools: { act: true }, timeoutMs: 5 },
        maxSteps: 1,
      }),
      ai,
    );
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      await h.settle();
      h.advance(6);
      const report = await h.service.sweep();
      await h.settle();
      expect(report.expired).toBe(1);
      expect(report.resumed).toBe(1);
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify((await h.service.get(h.ctx(), runId)).messages)).toContain('timed out');
      h.advance(86_400_001);
      expect((await h.service.sweep()).purged).toBe(1);
      expect(await h.store.get(runId)).toBeNull();
      expect(await h.store.approvals(runId)).toEqual([]);
    } finally {
      await h.close();
    }
  });
  it('bounds queries, skips lost decisions, resumes and purge races', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      const resume = vi.fn(async () => false);
      const resumable = vi.spyOn(h.store, 'resumable');
      await sweep(
        h.store,
        { now: h.runtime.now(), sweepBatch: 7, maxClockSkewMs: 12, retentionMs: 1 },
        resume,
      );
      expect(resumable).toHaveBeenCalledWith(h.runtime.now() - 12, 7);
      expect(resume).toHaveBeenCalledOnce();
    } finally {
      await h.close();
    }
  });
});
