/* eslint-disable require-await -- Test doubles preserve asynchronous provider contracts. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MockLanguageModelV4 } from 'ai/test';
import { createTestApp, overrideCapability } from '@setu-ts/testing';
import { createApp } from '../../../setu.config.ts';
import { CHAT_MODELS } from '../../plugins/chat-models.plugin.ts';
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
});
