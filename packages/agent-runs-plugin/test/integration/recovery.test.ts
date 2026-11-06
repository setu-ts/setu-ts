/* eslint-disable require-await -- Fakes preserve asynchronous provider and tool contracts. */
import { describe, it, expect, vi } from 'vitest';
import { jsonSchema } from 'ai';
import { harness, definition, fakeAi } from '../fixtures/harness.ts';
import { AgentRunService } from '../../src/service/agent-run-service.ts';
import { MockLanguageModelV4 } from 'ai/test';
import { loadAi } from '../fixtures/harness.ts';
describe('restart recovery', () => {
  it('expires a real SDK tool approval after service replacement and replays exact retained positions (G3/G4)', async () => {
    const model = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'tool-call', toolCallId: 'c', toolName: 'act', input: '{}' });
              c.enqueue({
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              });
              c.close();
            },
          }),
        }),
    });
    const execute = vi.fn(() => 'effect');
    const d = definition({
      model: () => model,
      maxSteps: 1,
      tools: { act: { inputSchema: jsonSchema({ type: 'object' }), execute } },
      approval: { tools: { act: true }, timeoutMs: 10 },
    });
    const h = await harness(d, await loadAi());
    const recovered = new AgentRunService(h.deps);
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', {
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await h.settle();
      expect((await h.store.get(runId))?.status).toBe('waiting');
      h.service.close();
      h.advance(11);
      expect((await recovered.sweep()).expired).toBe(1);
      await Promise.all([...recovered.work]);
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify((await recovered.get(h.ctx(), runId)).messages)).toContain(
        'execution-denied',
      );
      const row = (await h.store.get(runId))!;
      const chunks = (await h.store.chunks(row, 0)).flatMap((batch) =>
        batch.chunks.map((chunk, index) => ({
          id: `${batch.seq}.${index}.${batch.leaseVersion}`,
          chunk,
        })),
      );
      const cursor = chunks[1]!;
      const ctx = h.ctx('tenant', 'user', new Headers({ 'last-event-id': cursor.id }));
      await recovered.respond(ctx, runId);
      const body = await new Response(
        ctx.response.snapshot().body as ReadableStream<Uint8Array>,
      ).text();
      const received = body
        .split('\n')
        .filter((line) => line.startsWith('id: '))
        .map((line) => line.slice(4));
      expect(received).toEqual(chunks.slice(2).map((chunk) => chunk.id));
    } finally {
      recovered.close();
      await h.close();
    }
  });
  it('resumes a committed model entry without repeating model or effect (G1)', async () => {
    const execute = vi.fn(async () => 'effect');
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
      definition({ maxSteps: 1, tools: { act: { inputSchema: jsonSchema({}), execute } } }),
      ai,
    );
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = new AgentRunService({
      ...h.deps,
      hooks: {
        afterModelEntry: async () => {
          paused.resolve();
          await release.promise;
        },
      },
    });
    const second = new AgentRunService(h.deps);
    try {
      const { runId } = await first.start(h.ctx(), 'demo', { messages: [] });
      await paused.promise;
      expect(execute).not.toHaveBeenCalled();
      first.close();
      h.advance(35001);
      expect((await second.sweep()).resumed).toBe(1);
      await Promise.all([...second.work]);
      expect(ai.model).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await second.get(h.ctx(), runId)).status).toBe('completed');
      release.resolve();
      await Promise.all([...first.work]);
    } finally {
      release.resolve();
      first.close();
      second.close();
      await h.close();
    }
  });
});
