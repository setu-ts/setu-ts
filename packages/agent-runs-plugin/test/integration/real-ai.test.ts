/* eslint-disable require-await -- Fakes preserve asynchronous provider and tool contracts. */
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { readUIMessageStream } from 'ai';
import type { UIMessageChunk } from 'ai';
import { harness, definition, loadAi, failureLogger } from '../fixtures/harness.ts';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AgentRunsPlugin } from '../../src/index.ts';
import { CAPABILITIES, withHttpStatusHint } from '@setu-ts/common';
import type { IAgentRunService } from '@setu-ts/common';
describe('real AI SDK', () => {
  it('retains a real SDK model rejection and logs its quota class and 429 without provider text', async () => {
    const failure = withHttpStatusHint(
      Object.assign(new Error('private-quota-provider'), { name: 'QuotaExceededError' }),
      { status: 429, title: 'Quota Exceeded', detail: 'Quota exceeded.' },
    );
    const model = new MockLanguageModelV4({ doStream: () => Promise.reject(failure) });
    const ai = await loadAi();
    const generation = ai.model({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      maxOutputTokens: 10,
      abortSignal: new AbortController().signal,
    });
    expect(generation.failure()).toBeUndefined();
    const reader = generation.chunks.getReader();
    const chunks: UIMessageChunk[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    reader.releaseLock();
    expect(generation.failure()).toBe(failure);
    expect(chunks).toContainEqual({ type: 'error', errorText: 'Agent model call failed.' });
    expect(JSON.stringify(chunks)).not.toContain('private-quota-provider');
    const h = await harness(definition({ model: () => model }), ai);
    const logger = failureLogger();
    const warn = vi.spyOn(logger, 'warn');
    Object.assign(h.deps, { logger });
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', {
        messages: [{ role: 'user', content: 'hi' }],
      });
      await h.settle();
      expect((await h.store.get(runId))?.status).toBe('failed');
      expect(warn).toHaveBeenCalledWith('Agent run failed.', {
        definition: 'demo',
        error: 'QuotaExceededError',
        status: 429,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private-quota-provider');
    } finally {
      await h.close();
    }
  });
  it('converts a real SDK provider error to a safe failed run', async () => {
    const model = new MockLanguageModelV4({
      doStream: () => Promise.reject(new Error('provider secret')),
    });
    const h = await harness(definition({ model: () => model }), await loadAi());
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', {
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await h.settle();
      expect((await h.store.get(runId))?.status).toBe('failed');
      expect(JSON.stringify(await h.store.chunks((await h.store.get(runId))!, 0))).not.toContain(
        'provider secret',
      );
    } finally {
      await h.close();
    }
  });
  it('loads the real peer and produces chunks parsed by the SDK itself', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of [
              { type: 'stream-start', warnings: [] as import('ai').CallWarning[] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'Hello' },
              { type: 'text-end', id: 't' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ] as const)
              controller.enqueue(chunk);
            controller.close();
          },
        }),
      }),
    });
    const h = await harness(definition({ model: () => model }), await loadAi());
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', {
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await h.settle();
      const row = (await h.store.get(runId))!;
      expect(row.status).toBe('completed');
      const chunks = (await h.store.chunks(row, 0)).flatMap(
        (batch) => batch.chunks,
      ) as unknown as UIMessageChunk[];
      const parsed = readUIMessageStream({
        stream: new ReadableStream({
          start(c) {
            for (const chunk of chunks) c.enqueue(chunk);
            c.close();
          },
        }),
      });
      let final;
      for await (const message of parsed) final = message;
      expect(final?.parts).toContainEqual({ type: 'text', text: 'Hello', state: 'done' });
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          {
            name: 'idempotency-provider',
            version: '1',
            provides: [CAPABILITIES.IDEMPOTENCY],
            register(ctx) {
              ctx.services.register(CAPABILITIES.IDEMPOTENCY, h.deps.idempotency);
            },
          },
          AgentRunsPlugin({
            store: h.store,
            definitions: [definition({ model: () => model })],
            sweepIntervalMs: 0,
          }),
        ],
      });
      app.router.post('/runs', async (ctx) =>
        ctx.response.json(
          await ctx.services
            .get<IAgentRunService>(CAPABILITIES.AGENT_RUNS)
            .start(ctx, 'demo', { messages: [{ role: 'user', content: 'Hi' }] }),
        ),
      );
      app.router.get('/runs/:id/stream', (ctx) =>
        ctx.services.get<IAgentRunService>(CAPABILITIES.AGENT_RUNS).respond(ctx, ctx.params['id']!),
      );
      try {
        await app.start();
        const created = await app.fetch(new Request('http://localhost/runs', { method: 'POST' }));
        const handle = (await created.json()) as { runId: string };
        const replay = await app.fetch(
          new Request(`http://localhost/runs/${handle.runId}/stream`, {
            headers: { 'last-event-id': 'replay' },
          }),
        );
        expect(replay.headers.get('x-setu-run-id')).toBe(handle.runId);
        expect(replay.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
        expect(await replay.text()).toContain('Hello');
        expect(
          (await app.fetch(new Request(`http://localhost/runs/${handle.runId}/stream`))).status,
        ).toBe(204);
      } finally {
        await app.stop();
      }
    } finally {
      await h.close();
    }
  });
});
