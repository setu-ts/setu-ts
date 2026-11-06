import { describe, it, expect, vi } from 'vitest';
import { jsonSchema } from 'ai';
import { DuplicateKeyError } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import { harness, definition, fakeAi } from '../fixtures/harness.ts';
import { toolKey } from '../../src/loop/tool-runner.ts';
import { AgentRunService } from '../../src/service/agent-run-service.ts';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function replies(ids = ['A']) {
  return fakeAi([
    {
      messages: [
        {
          role: 'assistant',
          content: ids.map((id) => ({
            type: 'tool-call' as const,
            toolCallId: id,
            toolName: 'act',
            input: {},
          })),
        },
      ],
      finishReason: 'tool-calls',
      usage: {},
    },
  ]);
}
async function expire(h: Awaited<ReturnType<typeof harness>>, runId: string) {
  const run = (await h.store.get(runId))!;
  h.advance(run.leaseUntil + h.deps.options.maxClockSkewMs + 1 - h.runtime.now());
}

describe('tool timeout sweep recovery', () => {
  it('replays a transaction committed after the deadline, retaining its lease until expiry plus skew', async () => {
    const beforeCommit = gate();
    const commit = gate();
    const execute = vi.fn(
      async (_input: unknown, options: import('ai').ToolExecutionOptions<unknown>) => {
        await (options.context as IUnitOfWork).getRepository('Business').create({ id: 'effect' });
        return 'recorded-result';
      },
    );
    const h = await harness(
      definition({
        tools: { act: { inputSchema: jsonSchema({}), execute } },
        toolsContext: (_run, call) => ({ act: call.unitOfWork }),
        timeouts: { toolMs: 10 },
        maxSteps: 1,
      }),
      replies(),
    );
    // DatabaseService commits only after its work callback resolves. Holding
    // that boundary preserves the real within claim/result and atomic overlay.
    const transaction = h.db.transaction.bind(h.db);
    const tx = vi.spyOn(h.db, 'transaction').mockImplementation((work, options) =>
      transaction(async (uow) => {
        const value = await work(uow);
        beforeCommit.open();
        await commit.promise;
        return value;
      }, options),
    );
    const warn = vi.fn();
    const service = new AgentRunService({ ...h.deps, logger: { warn } as unknown as ILogger });
    try {
      const { runId } = await service.start(h.ctx(), 'demo', { messages: [] });
      await beforeCommit.promise;
      h.fire(10);
      while (service.work.size) await Promise.all([...service.work]);
      const run = (await h.store.get(runId))!;
      expect(run).toMatchObject({
        status: 'running',
        error: null,
        toolTimeouts: 1,
        toolTimeoutKey: await toolKey(h.runtime, runId, 0, 'A'),
        leaseOwner: service.owner,
      });
      expect(run.leaseUntil).toBe(h.runtime.now() + h.deps.options.leaseMs);
      expect([...h.timers.values()].filter((t) => t.interval)).toEqual([]);
      expect(warn.mock.calls).toEqual([
        ['Agent tool timed out.', { definition: 'demo', attempt: 1, limit: 3 }],
      ]);
      expect((await h.store.chunks(run, 0)).flatMap((b) => b.chunks)).not.toContainEqual(
        expect.objectContaining({ type: 'error' }),
      );
      expect(await h.db.getRepository('Business').count()).toBe(0);
      commit.open();
      await tx.mock.results[0]!.value;
      expect(await h.db.getRepository('Business').count()).toBe(1);
      h.advance(h.deps.options.leaseMs);
      expect((await service.sweep()).resumed).toBe(0);
      h.advance(h.deps.options.maxClockSkewMs);
      expect((await service.sweep()).resumed).toBe(0);
      h.advance(1);
      expect((await service.sweep()).resumed).toBe(1);
      expect((await h.store.get(runId))?.status).toBe('completed');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((await service.get(h.ctx(), runId)).messages)).toContain(
        'recorded-result',
      );
      expect(await h.db.getRepository('Business').count()).toBe(1);
    } finally {
      commit.open();
      service.close();
      tx.mockRestore();
      await h.close();
    }
  });

  it('runs a rolled-back call again and commits exactly one effect', async () => {
    const started = gate();
    const release = gate();
    const execute = vi.fn(
      async (_input: unknown, options: import('ai').ToolExecutionOptions<unknown>) => {
        await (options.context as IUnitOfWork).getRepository('Business').create({ id: 'effect' });
        if (execute.mock.calls.length === 1) {
          started.open();
          await release.promise;
        }
        return 'ok';
      },
    );
    const h = await harness(
      definition({
        tools: { act: { inputSchema: jsonSchema({}), execute } },
        toolsContext: (_run, call) => ({ act: call.unitOfWork }),
        timeouts: { toolMs: 10 },
        maxSteps: 1,
      }),
      replies(),
    );
    const within = vi.spyOn(h.deps.idempotency, 'within');
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      await started.promise;
      h.fire(10);
      await h.settle();
      expect(await h.store.get(runId)).toMatchObject({ status: 'running', toolTimeouts: 1 });
      release.open();
      // runTool's final throwIfAborted rejects the real within transaction.
      await expect(within.mock.results[0]!.value).rejects.toThrow('Agent tool failed.');
      expect(await h.db.getRepository('Business').count()).toBe(0);
      await expire(h, runId);
      expect((await h.service.sweep()).resumed).toBe(1);
      expect((await h.store.get(runId))?.status).toBe('completed');
      expect(execute).toHaveBeenCalledTimes(2);
      expect(await h.db.getRepository('Business').count()).toBe(1);
    } finally {
      release.open();
      within.mockRestore();
      await h.close();
    }
  });

  it.each([2, undefined])(
    'fails a hanging tool after the configured/default limit %s',
    async (limit) => {
      let started = gate();
      const execute = vi.fn(
        (_input: unknown, options: import('ai').ToolExecutionOptions<unknown>) => {
          started.open();
          return new Promise<never>((_resolve, reject) => {
            options.abortSignal!.addEventListener(
              'abort',
              () => reject(options.abortSignal!.reason),
              { once: true },
            );
          });
        },
      );
      const h = await harness(
        definition({
          tools: { act: { inputSchema: jsonSchema({}), execute } },
          timeouts: { toolMs: 10, ...(limit === undefined ? {} : { toolAttempts: limit }) },
          maxSteps: 1,
        }),
        replies(),
      );
      const within = vi.spyOn(h.deps.idempotency, 'within');
      try {
        const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
        const attempts = limit ?? 3;
        let recovery: Promise<unknown> = Promise.resolve();
        for (let n = 1; n <= attempts; n++) {
          await started.promise;
          h.fire(10);
          await recovery;
          await h.settle();
          await expect(within.mock.results.at(-1)!.value).rejects.toThrow('Agent tool failed.');
          const run = (await h.store.get(runId))!;
          expect(run.toolTimeouts).toBe(n);
          expect(run.status).toBe(n === attempts ? 'failed' : 'running');
          if (n < attempts) {
            started = gate();
            await expire(h, runId);
            recovery = h.service.sweep();
          }
        }
        const run = (await h.store.get(runId))!;
        expect(run).toMatchObject({ error: 'tool-timeout', leaseOwner: '', leaseUntil: 0 });
        expect(execute).toHaveBeenCalledTimes(attempts);
        expect(
          (await h.store.chunks(run, 0))
            .flatMap((b) => b.chunks)
            .filter((c) => (c as { type: string }).type === 'error'),
        ).toHaveLength(1);
        h.advance(h.deps.options.leaseMs + h.deps.options.maxClockSkewMs + 1);
        expect((await h.service.sweep()).resumed).toBe(0);
      } finally {
        within.mockRestore();
        await h.close();
      }
    },
  );

  it('starts the count at one when a later call has a different key', async () => {
    let started = gate();
    const execute = vi.fn(
      (_input: unknown, options: import('ai').ToolExecutionOptions<unknown>) => {
        if (options.toolCallId === 'A' && execute.mock.calls.length === 2) return 'ok';
        started.open();
        return new Promise<never>((_resolve, reject) => {
          options.abortSignal!.addEventListener(
            'abort',
            () => reject(options.abortSignal!.reason),
            { once: true },
          );
        });
      },
    );
    const h = await harness(
      definition({
        tools: { act: { inputSchema: jsonSchema({}), execute } },
        timeouts: { toolMs: 10, toolAttempts: 2 },
        maxSteps: 1,
      }),
      replies(['A', 'B']),
    );
    const within = vi.spyOn(h.deps.idempotency, 'within');
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      await started.promise;
      h.fire(10);
      await h.settle();
      await expect(within.mock.results[0]!.value).rejects.toThrow('Agent tool failed.');
      expect(await h.store.get(runId)).toMatchObject({
        status: 'running',
        toolTimeouts: 1,
        toolTimeoutKey: await toolKey(h.runtime, runId, 0, 'A'),
      });
      started = gate();
      await expire(h, runId);
      const recovery = h.service.sweep();
      await started.promise;
      h.fire(10);
      await recovery;
      await expect(within.mock.results[2]!.value).rejects.toThrow('Agent tool failed.');
      expect(await h.store.get(runId)).toMatchObject({
        status: 'running',
        toolTimeouts: 1,
        toolTimeoutKey: await toolKey(h.runtime, runId, 0, 'B'),
      });
      expect(execute).toHaveBeenCalledTimes(3);
    } finally {
      within.mockRestore();
      await h.close();
    }
  });

  it('fails with tool-timeout when the timed-out transaction never settles', async () => {
    const beforeCommit = gate();
    const execute = vi.fn(() => 'ok');
    const h = await harness(
      definition({
        tools: { act: { inputSchema: jsonSchema({}), execute } },
        timeouts: { toolMs: 10, toolAttempts: 2 },
        maxSteps: 1,
      }),
      replies(),
    );
    const transaction = h.db.transaction.bind(h.db);
    const tx = vi
      .spyOn(h.db, 'transaction')
      .mockImplementationOnce((work, options) =>
        transaction(async (uow) => {
          const value = await work(uow);
          beforeCommit.open();
          // Never settles: the holder's transaction stays open.
          return new Promise<never>(() => value);
        }, options),
      )
      .mockRejectedValue(new DuplicateKeyError('claim held'));
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      await beforeCommit.promise;
      h.fire(10);
      await h.settle();
      expect(await h.store.get(runId)).toMatchObject({ status: 'running', toolTimeouts: 1 });
      await expire(h, runId);
      expect((await h.service.sweep()).resumed).toBe(1);
      expect(await h.store.get(runId)).toMatchObject({
        status: 'failed',
        error: 'tool-timeout',
        toolTimeouts: 2,
        leaseOwner: '',
      });
      expect(execute).toHaveBeenCalledTimes(1);
      await expire(h, runId);
      expect((await h.service.sweep()).resumed).toBe(0);
    } finally {
      tx.mockRestore();
      await h.close();
    }
  });

  it('counts conflicts when the first timeout write failed and left no key', async () => {
    const beforeCommit = gate();
    const execute = vi.fn(() => 'ok');
    const h = await harness(
      definition({
        tools: { act: { inputSchema: jsonSchema({}), execute } },
        timeouts: { toolMs: 10, toolAttempts: 2 },
        maxSteps: 1,
      }),
      replies(),
    );
    const transaction = h.db.transaction.bind(h.db);
    const tx = vi
      .spyOn(h.db, 'transaction')
      .mockImplementationOnce((work, options) =>
        transaction(async (uow) => {
          const value = await work(uow);
          beforeCommit.open();
          return new Promise<never>(() => value);
        }, options),
      )
      .mockRejectedValue(new DuplicateKeyError('claim held'));
    // The first holder's timeout write fails, so the row never records the key.
    const update = h.store.update.bind(h.store);
    let failed = false;
    const write = vi.spyOn(h.store, 'update').mockImplementation((id, where, data) => {
      if ('toolTimeoutKey' in data && !failed) {
        failed = true;
        return Promise.reject(new Error('store unavailable'));
      }
      return update(id, where, data);
    });
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      await beforeCommit.promise;
      h.fire(10);
      await h.settle();
      expect(await h.store.get(runId)).toMatchObject({
        status: 'running',
        toolTimeoutKey: '',
        toolTimeouts: 0,
      });
      await expire(h, runId);
      await h.service.sweep();
      expect(await h.store.get(runId)).toMatchObject({ status: 'running', toolTimeouts: 1 });
      await expire(h, runId);
      await h.service.sweep();
      expect(await h.store.get(runId)).toMatchObject({
        status: 'failed',
        error: 'tool-timeout',
        toolTimeouts: 2,
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
      tx.mockRestore();
      await h.close();
    }
  });

  it('counts a still-in-flight claim conflict as an attempt and replays once it commits', async () => {
    const beforeCommit = gate();
    const commit = gate();
    const execute = vi.fn(() => 'ok');
    const h = await harness(
      definition({
        tools: { act: { inputSchema: jsonSchema({}), execute } },
        timeouts: { toolMs: 10 },
        maxSteps: 1,
      }),
      replies(),
    );
    const transaction = h.db.transaction.bind(h.db);
    const tx = vi
      .spyOn(h.db, 'transaction')
      .mockImplementationOnce((work, options) =>
        transaction(async (uow) => {
          const value = await work(uow);
          beforeCommit.open();
          await commit.promise;
          return value;
        }, options),
      )
      // The memory backend queues a concurrent claim. Emulate a backend's
      // unique-claim refusal; real within recover() maps it to hinted 409.
      .mockRejectedValueOnce(new DuplicateKeyError('claim held'));
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      await beforeCommit.promise;
      h.fire(10);
      await h.settle();
      expect(await h.store.get(runId)).toMatchObject({ status: 'running', toolTimeouts: 1 });
      await expire(h, runId);
      expect((await h.service.sweep()).resumed).toBe(1);
      expect(await h.store.get(runId)).toMatchObject({
        status: 'running',
        error: null,
        toolTimeouts: 2,
        leaseVersion: 2,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      commit.open();
      await tx.mock.results[0]!.value;
      await expire(h, runId);
      expect((await h.service.sweep()).resumed).toBe(1);
      expect((await h.store.get(runId))?.status).toBe('completed');
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      commit.open();
      tx.mockRestore();
      await h.close();
    }
  });
});
