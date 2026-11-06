/* eslint-disable require-await -- Fakes preserve asynchronous provider and tool contracts. */
import { describe, it, expect, vi } from 'vitest';
import { jsonSchema } from 'ai';
import { harness, definition, fakeAi, row } from '../fixtures/harness.ts';
import { changeRun, live, parked } from '../../src/approvals/approvals.ts';
import { prepareApprovals, decideApproval } from '../../src/approvals/approvals.ts';
import { claim } from '../../src/lease/lease.ts';
import { ChunkLog } from '../../src/log/chunk-log.ts';
import { entry } from '../fixtures/harness.ts';
const reply = {
  messages: [
    {
      role: 'assistant' as const,
      content: [{ type: 'tool-call' as const, toolCallId: 'c', toolName: 'act', input: {} }],
    },
  ],
  finishReason: 'tool-calls',
  usage: {},
};
describe('durable approvals', () => {
  for (const throughService of [false, true])
    it(`does not strand a decision racing the park transition (service=${throughService})`, async () => {
      const execute = vi.fn(() => 'effect');
      const h = await harness(
        definition({
          maxSteps: 1,
          tools: { act: { inputSchema: jsonSchema({}), execute } },
          approval: { tools: { act: true } },
        }),
        fakeAi([reply]),
      );
      let decision: Promise<void> | undefined;
      try {
        const original = h.store.update.bind(h.store);
        let raced = false;
        vi.spyOn(h.store, 'update').mockImplementation(async (id, where, data) => {
          const updated = await original(id, where, data);
          if (data.status === 'waiting' && !raced) {
            raced = true;
            const a = (await h.store.approvals(id))[0]!;
            if (throughService) decision = h.service.decide(h.ctx(), id, a.id, { approved: true });
            else await h.store.decide(a.id, { status: 'approved', decidedAt: h.runtime.now() });
          }
          return updated;
        });
        const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
        await h.settle();
        await decision;
        await h.settle();
        expect((await h.store.get(runId))?.status).toBe('completed');
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        await h.close();
      }
    });
  it('persists policy outcomes once and checks decision CAS races', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      const lease = (await claim(h.store, h.runtime, row(), 'A', 30000, 0))!;
      const e = entry(lease.row, { messages: reply.messages });
      lease.row = await h.store.appendEntry(lease.row, e);
      const log = new ChunkLog(lease, h.deps.options);
      const policy = vi.fn(() => true);
      const d = definition({
        tools: { act: { inputSchema: jsonSchema({}), execute: () => null } },
        approval: { tools: { act: policy }, canDecide: () => true },
      });
      const context = {
        runId: 'run',
        tenantId: 'tenant',
        principalId: null,
        services: h.deps.services,
        signal: lease.controller.signal,
      };
      const first = await prepareApprovals(lease, log, d, context, e);
      await prepareApprovals(lease, log, d, context, e);
      await prepareApprovals(lease, log, d, context, e);
      expect(policy).toHaveBeenCalledTimes(1);
      await expect(
        decideApproval(h.store, lease.row, d, context, h.ctx(), 'missing', { approved: true }, 0),
      ).rejects.toThrow();
      await expect(
        decideApproval(
          h.store,
          lease.row,
          d,
          context,
          h.ctx(),
          first[0]!.id,
          { approved: 'yes' } as never,
          0,
        ),
      ).rejects.toThrow();
      const spy = vi.spyOn(h.store, 'decide').mockResolvedValueOnce(null);
      await expect(
        decideApproval(
          h.store,
          lease.row,
          d,
          context,
          h.ctx(),
          first[0]!.id,
          { approved: true },
          0,
        ),
      ).rejects.toThrow();
      spy.mockRestore();
      await decideApproval(
        h.store,
        lease.row,
        d,
        context,
        h.ctx('tenant', ''),
        first[0]!.id,
        { approved: true },
        0,
      );
      await expect(
        decideApproval(
          h.store,
          lease.row,
          d,
          context,
          h.ctx(),
          first[0]!.id,
          { approved: true },
          0,
        ),
      ).rejects.toThrow();
      log.closeTimer();
      lease.stop();
    } finally {
      await h.close();
    }
  });
  for (const approved of [true, false])
    it(`decides once and resumes approved=${approved}`, async () => {
      const execute = vi.fn(async () => 'done');
      const policy = vi.fn(() => true);
      const h = await harness(
        definition({
          tools: { act: { inputSchema: jsonSchema({}), execute } },
          approval: { tools: { act: policy } },
          maxSteps: 1,
        }),
        fakeAi([reply]),
      );
      try {
        const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
        await h.settle();
        const view = await h.service.get(h.ctx(), runId);
        expect(view.status).toBe('waiting');
        expect(policy).toHaveBeenCalledTimes(1);
        const approval = view.pendingApprovals[0]!;
        await expect(
          h.service.decide(h.ctx('tenant', 'other'), runId, approval.id, { approved }),
        ).rejects.toMatchObject({ name: 'AgentRunApprovalError' });
        await expect(h.service.decide(h.ctx(), runId, 'missing', { approved })).rejects.toThrow();
        await h.service.decide(h.ctx(), runId, approval.id, { approved, reason: 'reviewed' });
        await h.settle();
        expect((await h.service.get(h.ctx(), runId)).status).toBe('completed');
        expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
        expect(policy).toHaveBeenCalledTimes(1);
        await expect(h.service.decide(h.ctx(), runId, approval.id, { approved })).rejects.toThrow();
      } finally {
        await h.close();
      }
    });
  it('supports custom principals, expiry refusal and cancellation while waiting', async () => {
    const h = await harness(
      definition({
        tools: { act: { inputSchema: jsonSchema({}), execute: () => null } },
        approval: { tools: { act: true }, timeoutMs: 10, canDecide: (p) => p?.id === 'reviewer' },
        maxSteps: 1,
      }),
      fakeAi([reply]),
    );
    try {
      const { runId } = await h.service.start(h.ctx('tenant', ''), 'demo', { messages: [] });
      await h.settle();
      const approval = (await h.service.get(h.ctx(), runId)).pendingApprovals[0]!;
      h.advance(11);
      await expect(
        h.service.decide(h.ctx('tenant', 'reviewer'), runId, approval.id, { approved: true }),
      ).rejects.toThrow();
      await h.service.cancel(h.ctx(), runId);
      await h.settle();
      expect((await h.store.get(runId))?.status).toBe('cancelled');
    } finally {
      await h.close();
    }
  });
  it('retries a lost run-state CAS only while the expected state holds', async () => {
    const h = await harness();
    try {
      const waiting = { ...row(), status: 'waiting' as const };
      await h.store.create(waiting);
      const update = vi.spyOn(h.store, 'update').mockResolvedValueOnce(null);
      expect((await changeRun(h.store, waiting, { status: 'ready' }, parked))?.status).toBe(
        'ready',
      );
      update.mockRestore();
      // Never matching from the start: no write at all.
      const writes = vi.spyOn(h.store, 'update');
      expect(await changeRun(h.store, row(), { status: 'ready' }, parked)).toBeNull();
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
      vi.spyOn(h.store, 'update').mockResolvedValue(null);
      await expect(changeRun(h.store, waiting, { status: 'ready' }, () => true)).rejects.toThrow();
      vi.spyOn(h.store, 'get').mockResolvedValue(null);
      expect(await changeRun(h.store, waiting, { status: 'ready' }, parked)).toBeNull();
    } finally {
      await h.close();
    }
  });
  it('never wakes a run another instance claimed after the stale read (review H3)', async () => {
    const h = await harness();
    try {
      const waiting = { ...row(), status: 'waiting' as const, leaseVersion: 3 };
      await h.store.create(waiting);
      // Another instance claims the run between this caller's read and its write.
      await h.store.update(
        waiting.id,
        { leaseVersion: 3 },
        { status: 'running', leaseVersion: 4, leaseOwner: 'I2', leaseUntil: 10 ** 12 },
      );
      expect(await changeRun(h.store, waiting, { status: 'ready' }, parked)).toBeNull();
      const current = await h.store.get(waiting.id);
      expect(current).toMatchObject({ status: 'running', leaseVersion: 4, leaseOwner: 'I2' });
      expect(live(current!)).toBe(true);
      expect(live({ ...current!, status: 'cancelled' })).toBe(false);
    } finally {
      await h.close();
    }
  });
});
