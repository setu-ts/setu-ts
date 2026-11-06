import { describe, it, expect, vi } from 'vitest';
import { harness, definition, fakeAi } from '../fixtures/harness.ts';
import { AgentRunService } from '../../src/service/agent-run-service.ts';
import { row } from '../fixtures/harness.ts';
import { claim } from '../../src/lease/lease.ts';
import { ChunkLog } from '../../src/log/chunk-log.ts';
describe('AgentRunService', () => {
  it('repairs a decision whose process died before waking the waiting run', async () => {
    const h = await harness();
    try {
      await h.store.create(
        row({ status: 'waiting', leaseOwner: 'other', leaseUntil: h.runtime.now() + 100 }),
      );
      expect(await h.service.resume((await h.store.get('run'))!)).toBe(false);
      await h.store.update('run', { leaseVersion: 0 }, { leaseOwner: '', leaseUntil: 0 });
      const waiting = (await h.store.get('run'))!;
      const approvals = vi
        .spyOn(h.store, 'approvals')
        .mockResolvedValueOnce([{ status: 'pending' } as never]);
      expect(await h.service.resume(waiting)).toBe(false);
      approvals.mockRestore();
      const update = vi.spyOn(h.store, 'update').mockResolvedValueOnce(null);
      expect(await h.service.resume(waiting)).toBe(false);
      update.mockRestore();
      expect((await h.service.sweep()).resumed).toBe(1);
      await h.settle();
      expect((await h.store.get('run'))?.status).toBe('completed');
    } finally {
      await h.close();
    }
  });
  it('serves a local tail and observes remote cancellation at renewal', async () => {
    const ai = fakeAi();
    let signal: AbortSignal | undefined;
    ai.model.mockImplementation((options) => {
      signal = options.abortSignal;
      return { chunks: new ReadableStream(), result: () => new Promise(() => {}) };
    });
    const h = await harness(definition(), ai);
    const remote = new AgentRunService(h.deps);
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      for (let n = 0; n < 100 && !signal; n++) await Promise.resolve();
      expect(await h.service.resume((await h.store.get(runId))!)).toBe(false);
      const ctx = h.ctx();
      await h.service.respond(ctx, runId);
      await (ctx.response.snapshot().body as ReadableStream<Uint8Array>).cancel();
      await remote.cancel(h.ctx(), runId);
      expect(signal?.aborted).toBe(false);
      h.fire(10000);
      await h.settle();
      expect(signal?.aborted).toBe(true);
      expect((await h.store.get(runId))?.status).toBe('cancelled');
    } finally {
      remote.close();
      await h.close();
    }
  });
  it('persists a decision on a local holder, including an absent reason', async () => {
    const h = await harness(definition({ approval: { tools: {}, canDecide: () => true } }));
    try {
      await h.store.create(row());
      const lease = (await claim(h.store, h.runtime, row(), 'A', 30000, 0))!;
      const log = new ChunkLog(lease, h.deps.options);
      h.service.active.set('run', log);
      await h.store.createApproval(lease.row, {
        id: 'a',
        runId: 'run',
        tenantId: 'tenant',
        seq: 0,
        toolCallId: 'c',
        toolName: 't',
        input: {},
        status: 'pending',
        deadline: h.runtime.now() + 100,
        decidedBy: null,
        decidedAt: null,
        reason: null,
      });
      await h.service.decide(h.ctx(), 'run', 'a', { approved: false });
      expect(log.snapshot()[0]?.chunk).toMatchObject({
        type: 'tool-approval-response',
        approved: false,
      });
      lease.stop();
      log.closeTimer();
    } finally {
      await h.close();
    }
  });
  it('abandons store faults without unfenced writes and returns failed views', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      const entries = vi.spyOn(h.store, 'entries').mockRejectedValue(new Error('store'));
      vi.spyOn(h.store, 'appendChunks').mockRejectedValue(new Error('store'));
      await h.service.resume(row());
      await h.settle();
      expect((await h.store.get('run'))?.status).toBe('running');
      entries.mockRestore();
      await h.store.update(
        'run',
        { leaseVersion: 1 },
        { status: 'failed', error: 'execution-failed' },
      );
      expect((await h.service.get(h.ctx(), 'run')).error).toBe('execution-failed');
      h.deps.definitions.clear();
      await h.store.update('run', { leaseVersion: 1 }, { status: 'waiting' });
      await expect(h.service.decide(h.ctx(), 'run', 'a', { approved: true })).rejects.toThrow(
        'Invalid agent run definition',
      );
    } finally {
      await h.close();
    }
  });
  it('persists and reads back a detached run, background receives its promise', async () => {
    const h = await harness();
    const background = vi.fn();
    const service = new AgentRunService({ ...h.deps, background });
    try {
      const { runId } = await service.start(h.ctx(), 'demo', {
        messages: [{ role: 'user', content: 'hi' }],
      });
      await Promise.all([...service.work]);
      expect(background).toHaveBeenCalledWith(expect.anything(), expect.any(Promise));
      expect(await service.get(h.ctx(), runId)).toMatchObject({
        status: 'completed',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      });
      expect(await service.resume((await h.store.get(runId))!)).toBe(false);
    } finally {
      service.close();
      await h.close();
    }
  });
  it('bounds input and rejects forged history, unknown names, closed service', async () => {
    const h = await harness();
    try {
      const small = new AgentRunService({
        ...h.deps,
        options: { ...h.deps.options, maxInputBytes: 1 },
      });
      await expect(
        small.start(h.ctx(), 'demo', { messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toMatchObject({ name: 'AgentRunStateError' });
      await expect(h.service.start(h.ctx(), 'missing', { messages: [] })).rejects.toThrow();
      for (const input of [
        null,
        { messages: null },
        { messages: [null] },
        { messages: [{ role: 'invalid', content: [] }] },
      ])
        await expect(h.service.start(h.ctx(), 'demo', input as never)).rejects.toThrow();
      h.service.close();
      await expect(h.service.start(h.ctx(), 'demo', { messages: [] })).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
  it('cancels a locally blocked provider without waiting for renewal', async () => {
    const ai = fakeAi();
    let signal: AbortSignal | undefined;
    ai.model.mockImplementation((options) => {
      signal = options.abortSignal;
      return { chunks: new ReadableStream(), result: () => new Promise(() => {}) };
    });
    const h = await harness(definition(), ai);
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      for (let n = 0; n < 100 && !signal; n++) await Promise.resolve();
      await h.service.cancel(h.ctx(), runId);
      expect(signal?.aborted).toBe(true);
      await h.settle();
      expect((await h.store.get(runId))?.status).toBe('cancelled');
      await expect(h.service.cancel(h.ctx(), runId)).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
});
