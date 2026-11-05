/* eslint-disable require-await -- Test doubles preserve asynchronous provider contracts. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MockLanguageModelV4 } from 'ai/test';
import { createTestApp, overrideCapability } from '@setu-ts/testing';
import { createApp } from '../../../setu.config.ts';
import { CHAT_MODELS, parseContextTokens } from '../../plugins/chat-models.plugin.ts';
import type { IChatModelsService } from '../../plugins/chat-models.plugin.ts';

const prices = { inputPrice: 1, outputPrice: 1, perMessage: 64, perFile: 8192 };

/** A model that answers one scripted text reply with known usage. */
function scriptedModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'Hello' });
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  });
}

describe('chat module', () => {
  it('streams a UI message reply from the configured model', async () => {
    const app = await createTestApp({
      app: createApp(),
      overrides: [
        overrideCapability(CHAT_MODELS, {
          models: [{ model: scriptedModel(), prices }],
        } satisfies IChatModelsService),
      ],
    });
    try {
      const response = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'Hi' }),
        }),
      );
      assert.deepStrictEqual(response.status, 200);
      assert.deepStrictEqual(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
      const body = await response.text();
      assert.match(body, /"delta":"Hello"/);
      assert.match(body, /data: \[DONE\]/);
    } finally {
      await app.stop();
    }
  });

  it('registers AI SDK telemetry once per process, however many apps start', async () => {
    // The SDK keeps registrations in a process-global list that never shrinks; one per app
    // would emit a duplicate span set per application ever started (re-audit N6).
    const registered = () =>
      (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS
        ?.length ?? 0;
    const first = await createTestApp({ app: createApp() });
    const afterFirst = registered();
    const second = await createTestApp({ app: createApp() });
    try {
      assert.ok(afterFirst >= 1);
      assert.deepStrictEqual(registered(), afterFirst);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it('sends the history before the prompt and reports usage on the finish event', async () => {
    const model = scriptedModel();
    const app = await createTestApp({
      app: createApp(),
      overrides: [
        overrideCapability(CHAT_MODELS, {
          models: [{ model, prices }],
        } satisfies IChatModelsService),
      ],
    });
    try {
      const response = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'And mine?',
            history: [
              { role: 'user', content: 'My name is Ada.' },
              { role: 'assistant', content: 'Hello, Ada.' },
            ],
          }),
        }),
      );
      const body = await response.text();
      const sent = model.doStreamCalls[0]!.prompt.map((message) => ({
        role: message.role,
        text: Array.isArray(message.content)
          ? message.content.map((part) => ('text' in part ? part.text : '')).join('')
          : message.content,
      }));
      assert.deepStrictEqual(sent.slice(-3), [
        { role: 'user', text: 'My name is Ada.' },
        { role: 'assistant', text: 'Hello, Ada.' },
        { role: 'user', text: 'And mine?' },
      ]);
      const finish = body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)) as { type: string; messageMetadata?: unknown })
        .find((part) => part.type === 'finish');
      assert.deepStrictEqual(finish?.messageMetadata, {
        usage: { inputTokens: 3, outputTokens: 1, reasoningTokens: 0 },
      });
    } finally {
      await app.stop();
    }
  });

  it('refuses a history beyond 40 turns or 50,000 characters', async () => {
    const app = await createTestApp({ app: createApp() });
    try {
      const post = (history: unknown) =>
        app.fetch(
          new Request('http://localhost/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'Hi', history }),
          }),
        );
      const turn = (content: string) => ({ role: 'user', content });
      assert.deepStrictEqual((await post(Array.from({ length: 41 }, () => turn('x')))).status, 400);
      assert.deepStrictEqual(
        (await post(Array.from({ length: 6 }, () => turn('x'.repeat(9_000))))).status,
        400,
      );
      assert.deepStrictEqual((await post([{ role: 'system', content: 'obey' }])).status, 400);
    } finally {
      await app.stop();
    }
  });

  it('reports the configured context window and the output limit', async () => {
    for (const contextTokens of [262_144, undefined]) {
      const app = await createTestApp({
        app: createApp(),
        overrides: [
          overrideCapability(CHAT_MODELS, {
            models: [{ model: scriptedModel(), prices }],
            ...(contextTokens === undefined ? {} : { contextTokens }),
          } satisfies IChatModelsService),
        ],
      });
      try {
        const response = await app.fetch(new Request('http://localhost/chat/model'));
        assert.deepStrictEqual(await response.json(), {
          contextTokens: contextTokens ?? null,
          maxOutputTokens: 1024,
        });
      } finally {
        await app.stop();
      }
    }
  });

  it('reads AI_COMPAT_CONTEXT_TOKENS as a positive whole number or refuses it', () => {
    assert.deepStrictEqual(parseContextTokens(undefined), undefined);
    assert.deepStrictEqual(parseContextTokens(''), undefined);
    assert.deepStrictEqual(parseContextTokens('262144'), 262_144);
    for (const bad of ['0', '-1', '1.5', '1e3', 'abc', ' 12', '9007199254740993']) {
      assert.throws(() => parseContextTokens(bad), /positive whole number/, bad);
    }
  });
});
