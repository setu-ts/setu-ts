import { describe, it, expect, vi } from 'vitest';
import { harness, definition, fakeAi } from '../fixtures/harness.ts';
import { AgentRunService } from '../../src/service/agent-run-service.ts';
import { row } from '../fixtures/harness.ts';
import { claim, Lease } from '../../src/lease/lease.ts';
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
  it('reports success for a committed decision whose wake loses to another instance (review M2)', async () => {
    const h = await harness(definition({ approval: { tools: {}, canDecide: () => true } }));
    try {
      await h.store.create(row({ status: 'waiting', approvalIds: ['a'] }));
      vi.spyOn(h.store, 'approvals')
        .mockResolvedValueOnce([
          { id: 'a', runId: 'run', status: 'pending', deadline: 10 ** 15 } as never,
        ])
        .mockResolvedValue([{ id: 'a', runId: 'run', status: 'approved' } as never]);
      vi.spyOn(h.store, 'decide').mockResolvedValue({
        id: 'a',
        status: 'approved',
        reason: null,
      } as never);
      // Every later run write loses its compare-and-set.
      vi.spyOn(h.store, 'update').mockResolvedValue(null);
      await expect(
        h.service.decide(h.ctx(), 'run', 'a', { approved: true }),
      ).resolves.toBeUndefined();
      // Any other failure after the decision still reaches the caller.
      vi.spyOn(h.store, 'approvals').mockResolvedValue([
        { id: 'a', runId: 'run', status: 'pending', deadline: 10 ** 15 } as never,
      ]);
      vi.spyOn(h.store, 'get')
        .mockResolvedValueOnce((await h.store.get('run'))!)
        .mockRejectedValueOnce(new Error('store down'));
      await expect(h.service.decide(h.ctx(), 'run', 'a', { approved: true })).rejects.toThrow(
        'store down',
      );
    } finally {
      await h.close();
    }
  });
  it('claims the whole sweep batch and purges before awaiting recovered work (review M3)', async () => {
    const ai = fakeAi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    ai.model.mockImplementation(() => ({
      chunks: new ReadableStream({ start: (c) => c.close() }),
      result: async () => {
        await gate;
        return { messages: [{ role: 'assistant', content: 'x' }], finishReason: 'stop', usage: {} };
      },
    }));
    const h = await harness(definition(), ai);
    try {
      await h.store.create(row({ id: 'a', status: 'ready' }));
      await h.store.create(row({ id: 'b', status: 'ready' }));
      await h.store.create(row({ id: 'old', status: 'completed', updatedAt: 0 }));
      h.advance(100_000_000);
      const sweeping = h.service.sweep();
      // A second tick while the first is still waiting is a no-op.
      expect(await h.service.sweep()).toEqual({ expired: 0, resumed: 0, purged: 0 });
      for (let n = 0; n < 200; n++) await Promise.resolve();
      expect(await h.store.get('old')).toBeNull();
      expect((await h.store.get('a'))?.status).toBe('running');
      expect((await h.store.get('b'))?.status).toBe('running');
      release();
      expect(await sweeping).toEqual({ expired: 0, resumed: 2, purged: 1 });
      expect((await h.store.get('a'))?.status).toBe('completed');
    } finally {
      await h.close();
    }
  });
  it('cancel never re-wakes a run another instance holds (review H3)', async () => {
    const h = await harness();
    try {
      await h.store.create(
        row({ status: 'running', leaseOwner: 'I2', leaseVersion: 4, leaseUntil: 10 ** 15 }),
      );
      await h.service.cancel(h.ctx(), 'run');
      expect(await h.store.get('run')).toMatchObject({
        status: 'running',
        leaseOwner: 'I2',
        leaseVersion: 4,
        cancelRequested: true,
      });
      // The flag write keeps losing while the run goes terminal underneath.
      const flagged = (await h.store.get('run'))!;
      vi.spyOn(h.store, 'update').mockResolvedValue(null);
      vi.spyOn(h.store, 'get')
        .mockResolvedValueOnce(flagged)
        .mockResolvedValue({ ...flagged, status: 'completed' });
      await expect(h.service.cancel(h.ctx(), 'run')).resolves.toBeUndefined();
    } finally {
      await h.close();
    }
  });
  it('lets the next tick sweep while an earlier sweep waits on recovered work (fix review F2)', async () => {
    const ai = fakeAi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    ai.model.mockImplementation(() => ({
      chunks: new ReadableStream({ start: (c) => c.close() }),
      result: async () => {
        await gate;
        return { messages: [{ role: 'assistant', content: 'x' }], finishReason: 'stop', usage: {} };
      },
    }));
    const h = await harness(definition(), ai);
    try {
      await h.store.create(row({ id: 'long', status: 'ready' }));
      const first = h.service.sweep();
      for (let n = 0; n < 200; n++) await Promise.resolve();
      await h.store.create(row({ id: 'other', status: 'ready' }));
      const second = h.service.sweep();
      for (let n = 0; n < 200; n++) await Promise.resolve();
      expect((await h.store.get('other'))?.status).toBe('running');
      release();
      expect((await first).resumed).toBe(1);
      expect((await second).resumed).toBe(1);
    } finally {
      await h.close();
    }
  });
  it('wakes a parked run when the local holder lost its lease mid-decision (fix review F4)', async () => {
    const h = await harness(definition({ approval: { tools: {}, canDecide: () => true } }));
    try {
      await h.store.create(row({ status: 'waiting', approvalIds: ['a'] }));
      vi.spyOn(h.store, 'approvals')
        .mockResolvedValueOnce([
          { id: 'a', runId: 'run', status: 'pending', deadline: 10 ** 15 } as never,
        ])
        .mockResolvedValue([{ id: 'a', runId: 'run', status: 'approved' } as never]);
      vi.spyOn(h.store, 'decide').mockResolvedValue({
        id: 'a',
        status: 'approved',
        reason: null,
      } as never);
      const stale = new Lease((await h.store.get('run'))!, h.store, h.runtime, 30000);
      stale.stop(true);
      h.service.active.set('run', new ChunkLog(stale, h.deps.options));
      const resume = vi.spyOn(h.service, 'resume').mockResolvedValue(true);
      await h.service.decide(h.ctx(), 'run', 'a', { approved: true });
      expect(resume).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ready' }),
        expect.anything(),
      );
    } finally {
      h.service.active.clear();
      await h.close();
    }
  });
  it('keeps a later sweep guard when an earlier sweep finishes waiting (review)', async () => {
    const ai = fakeAi();
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => (releaseRun = resolve));
    let modelStarted!: () => void;
    const modelCalled = new Promise<void>((resolve) => (modelStarted = resolve));
    ai.model.mockImplementation(() => ({
      chunks: new ReadableStream({ start: (c) => c.close() }),
      result: async () => {
        modelStarted();
        await runGate;
        return { messages: [{ role: 'assistant', content: 'x' }], finishReason: 'stop', usage: {} };
      },
    }));
    const h = await harness(definition(), ai);
    try {
      await h.store.create(row({ id: 'long', status: 'ready' }));
      // Sweep A recovers `long`; once its model call starts, A is waiting on it.
      const a = h.service.sweep();
      await modelCalled;
      // Sweep B starts and is held inside its scan.
      let releaseScan!: () => void;
      const scanGate = new Promise<void>((resolve) => (releaseScan = resolve));
      let scanEntered!: () => void;
      const inScan = new Promise<void>((resolve) => (scanEntered = resolve));
      const expired = h.store.expired.bind(h.store);
      const scans = vi.spyOn(h.store, 'expired').mockImplementation(async (now, limit) => {
        scanEntered();
        await scanGate;
        return expired(now, limit);
      });
      const b = h.service.sweep();
      await inScan;
      // A finishes waiting while B still scans; a third sweep must not start.
      releaseRun();
      await a;
      expect(await h.service.sweep()).toEqual({ expired: 0, resumed: 0, purged: 0 });
      expect(scans).toHaveBeenCalledTimes(1);
      releaseScan();
      await b;
    } finally {
      await h.close();
    }
  });
  it('waits for recovered work even when a later step of the sweep fails (review)', async () => {
    const ai = fakeAi();
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => (releaseRun = resolve));
    ai.model.mockImplementation(() => ({
      chunks: new ReadableStream({ start: (c) => c.close() }),
      result: async () => {
        await runGate;
        return { messages: [{ role: 'assistant', content: 'x' }], finishReason: 'stop', usage: {} };
      },
    }));
    const h = await harness(definition(), ai);
    try {
      await h.store.create(row({ id: 'long', status: 'ready' }));
      let terminalEntered!: () => void;
      const terminalCalled = new Promise<void>((resolve) => (terminalEntered = resolve));
      vi.spyOn(h.store, 'terminal').mockImplementationOnce(() => {
        terminalEntered();
        return Promise.reject(new Error('store down'));
      });
      let settled = false;
      const sweeping = h.service.sweep();
      void sweeping.then(
        () => (settled = true),
        () => (settled = true),
      );
      await terminalCalled;
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The purge step failed, but the recovered run is still being awaited.
      expect(settled).toBe(false);
      releaseRun();
      await expect(sweeping).rejects.toThrow('store down');
      expect((await h.store.get('long'))?.status).toBe('completed');
    } finally {
      await h.close();
    }
  });
});
