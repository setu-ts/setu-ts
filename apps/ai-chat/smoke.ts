/* eslint-disable require-await -- Test doubles preserve asynchronous provider and service contracts. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  APICallError,
  generateText,
  isStepCount,
  NoObjectGeneratedError,
  Output,
  parseJsonEventStream,
  readUIMessageStream,
  registerTelemetry,
  uiMessageChunkSchema,
  wrapLanguageModel,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { OpenTelemetry } from '@ai-sdk/otel';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createFallback } from 'ai-fallback';
import { trace, context } from '@opentelemetry/api';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, ITelemetryService, OutboxRecord } from '@setu-ts/common';
import { createQuota, MemoryQuotaStore, QuotaExceededError } from '@setu-ts/auth-plugin';
import { createRuntimeServices } from '@setu-ts/runtime';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import type { IOutbox } from '@setu-ts/messaging-plugin';
import { createApp } from './setu.config.ts';
import { tenantTool } from './src/chat.routes.ts';
import { budgetMiddleware } from './src/budget-middleware.ts';
import { usageRecorded, writeUsage } from './src/usage.ts';
import type { UsageRecord } from './src/usage.ts';

type Model = ReturnType<typeof wrapLanguageModel>;
type Result = Awaited<ReturnType<Model['doGenerate']>>;
type StreamPart =
  Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never;
const runtime = createRuntimeServices();
const prices = { inputPrice: 1, outputPrice: 2, perMessage: 64, perFile: 8192 };
const usage: Result['usage'] = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
const result = (text = 'scripted answer'): Result => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  warnings: [],
});
function mock() {
  return new MockLanguageModelV4({
    doGenerate: async () => result(),
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          for (const part of [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: 'scripted answer' },
            { type: 'text-end', id: 'text' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
          ] satisfies StreamPart[])
            controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
}
function chatRequest(signal?: AbortSignal) {
  return new Request('http://localhost/chat', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'private-prompt-marker', tenantId: 'forged-tenant' }),
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'forged-tenant' },
    ...(signal ? { signal } : {}),
  });
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const start = runtime.hrtime();
  while (runtime.hrtime() - start < 5000) {
    if (await check()) return;
    await new Promise<void>((resolve) => runtime.setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for observable state');
}

describe('AI SDK recipes through Setu (Node)', () => {
  it('1a/6: caps the tool loop and reads tenant identity from toolsContext, ignoring model input', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        ...result(),
        content: [
          {
            type: 'tool-call',
            toolCallId: runtime.uuid(),
            toolName: 'tenant',
            input: JSON.stringify({ tenantId: 'forged-by-model' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      }),
    });
    const response = await generateText({
      model,
      prompt: 'use tenant tool',
      tools: { tenant: tenantTool },
      toolsContext: { tenant: { tenantId: 'trusted-tenant' } },
      stopWhen: isStepCount(3),
      abortSignal: new AbortController().signal,
    });
    assert.equal(model.doGenerateCalls.length, 3);
    assert.equal(response.steps.length, 3);
    for (const step of response.steps) assert.equal(step.toolResults[0]?.output, 'trusted-tenant');
  });

  it('2: the UI stream has SSE framing and is read by the SDK parser and message reader', async () => {
    const app = createApp([{ model: mock(), prices }]);
    await app.start();
    try {
      const response = await app.fetch(chatRequest());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
      const [wire, parsed] = response.body!.tee();
      const wireText = new Response(wire).text();
      const chunks = parseJsonEventStream({
        stream: parsed,
        schema: uiMessageChunkSchema,
      }).pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (!part.success) throw part.error;
            controller.enqueue(part.value);
          },
        }),
      );
      let text = '';
      for await (const message of readUIMessageStream({ stream: chunks }))
        text = message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
      assert.equal(text, 'scripted answer');
      assert.match(await wireText, /data: \[DONE\]/);
    } finally {
      await app.stop();
    }
  });

  it('1b: aborting ctx.signal mid-stream ends the route response', async () => {
    let cancelled = false;
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 't' });
            controller.enqueue({ type: 'text-delta', id: 't', delta: 'first' });
            abortSignal?.addEventListener(
              'abort',
              () => {
                cancelled = true;
                controller.close();
              },
              { once: true },
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });
    const app = createApp([{ model, prices }]);
    await app.start();
    try {
      const abort = new AbortController();
      const response = await app.fetch(chatRequest(abort.signal));
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('first')) {
        const part = await reader.read();
        assert.equal(part.done, false);
        text += new TextDecoder().decode(part.value);
      }
      abort.abort();
      await waitFor(async () => (await reader.read()).done === true);
      assert.equal(cancelled, true);
    } finally {
      await app.stop();
    }
  });

  it('3: exactly one of two calls can reserve the last tenant budget', async () => {
    const quota = createQuota({
      name: 'ai-spend',
      store: new MemoryQuotaStore(runtime),
      runtime,
      limit: 1,
      window: 'utc-day',
    });
    const replies = await Promise.allSettled([
      quota.reserve('trusted-tenant', 1),
      quota.reserve('trusted-tenant', 1),
    ]);
    assert.equal(replies.filter((reply) => reply.status === 'fulfilled').length, 1);
    const refused = replies.find((reply) => reply.status === 'rejected');
    assert.ok(refused?.status === 'rejected' && refused.reason instanceof QuotaExceededError);
  });

  it('4: reads usage back once after a redelivered outbox envelope', async () => {
    const app = createApp([{ model: mock(), prices }]);
    await app.start();
    try {
      await (await app.fetch(chatRequest())).text();
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const rows = () => db.getRepository<UsageRecord>('Usage').findAll();
      await waitFor(async () => (await rows()).length === 1);
      const [record] = await rows();
      assert.equal(record!.tenantId, 'demo-tenant');
      assert.equal(record!.settledAmount, 7);
      const [outbox] = await db.getRepository<OutboxRecord>('Outbox').findAll();
      assert.ok(outbox);
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      await broker.publish(usageRecorded.topic, JSON.parse(outbox.envelope));
      await broker.publish(usageRecorded.topic, JSON.parse(outbox.envelope));
      // Broker dispatch is asynchronous; wait for the duplicate inbox claim to complete.
      await new Promise<void>((resolve) => runtime.setTimeout(resolve, 80));
      assert.deepEqual(await rows(), [record]);
      assert.equal((await db.getRepository('Inbox').findAll()).length, 1);
    } finally {
      await app.stop();
    }
  });

  it('5/O8: OTLP spans parent under the request, capture off excludes prompts, capture on is a positive control', async () => {
    type Span = {
      name: string;
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      attributes: unknown[];
      events?: unknown[];
    };
    const spans: Span[] = [];
    const receiver = createServer(async (request, response) => {
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(buffers).toString()) as {
        resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
      };
      for (const resource of body.resourceSpans)
        for (const scope of resource.scopeSpans) spans.push(...scope.spans);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const address = receiver.address();
    assert.ok(address && typeof address === 'object');
    registerTelemetry(new OpenTelemetry({ tracer: trace.getTracer('gen_ai') }));
    const app = createApp([{ model: mock(), prices }], {
      serviceName: 'ai-smoke',
      exporter: 'otlp',
      endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
      registerGlobal: true,
    });
    await app.start();
    try {
      await (await app.fetch(chatRequest())).text();
      await waitFor(async () => spans.some((span) => span.name.includes('/chat')));
      const parent = spans.find((span) => span.name.includes('/chat'))!;
      const aiSpans = spans.filter(
        (span) => span.name.startsWith('invoke_agent') || span.name.startsWith('chat '),
      );
      assert.ok(
        aiSpans.length > 0,
        'SDK spans must actually reach Setu exporter: ' + JSON.stringify(spans),
      );
      for (const span of aiSpans) assert.equal(span.traceId, parent.traceId);
      assert.ok(aiSpans.some((span) => span.parentSpanId === parent.spanId));
      assert.equal(JSON.stringify(spans).includes('private-prompt-marker'), false);
      const service = app.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);
      await service.withSpan('positive-control', async () => {
        await generateText({
          model: mock(),
          prompt: 'capture-positive-marker',
          telemetry: { recordInputs: true, recordOutputs: true },
        });
      });
      await waitFor(async () => JSON.stringify(spans).includes('capture-positive-marker'));
    } finally {
      await app.stop();
      trace.disable();
      context.disable();
      receiver.close();
      await once(receiver, 'close');
    }
  });

  it('7: releases a failed first model and falls back after its 503', async () => {
    const first = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: 'unavailable',
          url: 'http://provider.invalid',
          requestBodyValues: {},
          statusCode: 503,
        });
      },
    });
    const second = mock();
    const app = createApp([{ model: second, prices }]);
    await app.start();
    try {
      app.router.get('/fallback-proof', {
        handler: async (ctx) => {
          const quota = createQuota({
            name: 'proof',
            limit: 10_000,
            window: 'utc-day',
            store: new MemoryQuotaStore(runtime),
            runtime,
          });
          const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
          const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
          const wrap = (model: Model) =>
            wrapLanguageModel({
              model,
              middleware: budgetMiddleware(ctx, quota, runtime, prices, (record) =>
                writeUsage(db, outbox, record),
              ),
            });
          const answer = await generateText({
            model: createFallback({ models: [wrap(first), wrap(second)] }),
            prompt: 'fallback',
            maxOutputTokens: 128,
            maxRetries: 0,
          });
          // A held first reservation would make this remaining-budget read fail.
          await quota.reserve('demo-tenant', 10_000 - 7);
          return ctx.response.text(answer.text);
        },
      });
      const response = await app.inject({ method: 'GET', url: '/fallback-proof' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, 'scripted answer');
      assert.equal(first.doGenerateCalls.length, 1);
      assert.equal(second.doGenerateCalls.length, 1);
    } finally {
      await app.stop();
    }
  });

  it('initial route quota refusal is a 429 before streaming and never calls the provider', async () => {
    const model = mock();
    const app = createApp([{ model, prices: { ...prices, inputPrice: 1_000_000 } }]);
    await app.start();
    try {
      const response = await app.fetch(chatRequest());
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('Retry-After')) >= 1);
      assert.equal(
        ((await response.json()) as Record<string, unknown>)['detail'],
        'The quota for this request is spent.',
      );
      assert.equal(model.doStreamCalls.length, 0);
    } finally {
      await app.stop();
    }
  });

  it('budget middleware refunds known usage, releases early failures and fully charges unknown, aborted and failed streams', async () => {
    const app = createApp([{ model: mock(), prices }]);
    app.router.get('/accounting', {
      handler: async (ctx) => {
        const params = {
          prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'é' }] }],
          maxOutputTokens: 10,
        };
        for (const scenario of [
          'known',
          'unknown',
          'generate-failure',
          'stream-failure',
          'read-failure',
          'late-error',
          'abort',
          'cancel',
          'missing-max',
          'media',
        ] as const) {
          const records: UsageRecord[] = [];
          const memory = new MemoryQuotaStore(runtime);
          let reserved = 0;
          const quota = createQuota({
            name: 'accounting',
            runtime,
            window: 'utc-day',
            limit: 100_000,
            store: {
              reserve(key, window, amount, limit, expiry) {
                reserved = amount;
                return memory.reserve(key, window, amount, limit, expiry);
              },
              adjust: (...args) => memory.adjust(...args),
            },
          });
          const abort = new AbortController();
          const model = new MockLanguageModelV4({
            doGenerate: async () => {
              if (scenario === 'generate-failure') throw new Error('provider failed');
              return {
                ...result(),
                usage:
                  scenario === 'unknown'
                    ? { ...usage, inputTokens: { ...usage.inputTokens, cacheRead: undefined } }
                    : usage,
              };
            },
            doStream: async () => {
              if (scenario === 'stream-failure') throw new Error('provider failed');
              if (scenario === 'read-failure')
                return {
                  stream: new ReadableStream<StreamPart>({
                    start(controller) {
                      controller.error(new Error('first read failed'));
                    },
                  }),
                };
              return {
                stream: new ReadableStream<StreamPart>({
                  start(controller) {
                    controller.enqueue({ type: 'text-start', id: 't' });
                    if (scenario === 'late-error')
                      controller.enqueue({ type: 'error', error: new Error('after first part') });
                    else
                      controller.enqueue({
                        type: 'finish',
                        finishReason: { unified: 'stop', raw: 'stop' },
                        usage,
                      });
                    controller.close();
                  },
                }),
              };
            },
          });
          const wrapped = wrapLanguageModel({
            model,
            middleware: budgetMiddleware(
              { ...ctx, signal: abort.signal },
              quota,
              runtime,
              prices,
              async (record) => {
                records.push(record);
              },
            ),
          });
          if (scenario === 'missing-max') {
            await assert.rejects(
              Promise.resolve(wrapped.doGenerate({ prompt: params.prompt })),
              TypeError,
            );
            assert.equal(reserved, 0);
          } else if (
            scenario === 'generate-failure' ||
            scenario === 'stream-failure' ||
            scenario === 'read-failure'
          ) {
            await assert.rejects(
              Promise.resolve(
                scenario === 'generate-failure'
                  ? wrapped.doGenerate(params)
                  : wrapped.doStream(params),
              ),
            );
            assert.deepEqual(records, []);
            await quota.reserve('demo-tenant', 100_000);
          } else {
            if (scenario === 'abort' || scenario === 'cancel' || scenario === 'late-error') {
              const stream = await wrapped.doStream(params);
              const reader = stream.stream.getReader();
              await reader.read();
              if (scenario === 'abort') abort.abort();
              if (scenario === 'cancel') await reader.cancel();
              else
                while (!(await reader.read()).done) {
                  /* drain */
                }
            } else {
              await wrapped.doGenerate(
                scenario === 'media'
                  ? {
                      ...params,
                      prompt: [
                        {
                          role: 'user',
                          content: [
                            {
                              type: 'file',
                              mediaType: 'image/png',
                              data: {
                                type: 'url',
                                url: new URL('https://media.invalid/image.png'),
                              },
                            },
                          ],
                        },
                      ],
                    }
                  : params,
              );
            }
            const [record] = records;
            assert.ok(record);
            const full =
              scenario === 'unknown' ||
              scenario === 'abort' ||
              scenario === 'cancel' ||
              scenario === 'late-error';
            assert.equal(record.usageKnown, !full);
            assert.equal(record.settledAmount, full ? reserved : 7);
            if (scenario === 'media') assert.ok(reserved >= prices.perFile);
            await quota.reserve('demo-tenant', 100_000 - record.settledAmount);
          }
        }
        return ctx.response.text('accounting checked');
      },
    });
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: '/accounting' });
      assert.equal(response.statusCode, 200, response.body ?? undefined);
      assert.equal(response.body, 'accounting checked');
    } finally {
      await app.stop();
    }
  });

  it('structured output validates a schema and reports malformed output', async () => {
    const output = Output.object({ schema: z.object({ answer: z.number() }) });
    const good = new MockLanguageModelV4({ doGenerate: async () => result('{"answer":42}') });
    assert.deepEqual((await generateText({ model: good, prompt: 'json', output })).output, {
      answer: 42,
    });
    await assert.rejects(
      generateText({ model: mock(), prompt: 'json', output }),
      (error: unknown) => NoObjectGeneratedError.isInstance(error),
    );
  });

  it(
    '8: real OpenAI-compatible endpoint',
    { skip: !runtime.env['AI_COMPAT_BASE_URL'] },
    async () => {
      const provider = createOpenAICompatible({
        name: 'compat',
        baseURL: runtime.env['AI_COMPAT_BASE_URL']!,
        ...(runtime.env['AI_COMPAT_API_KEY'] ? { apiKey: runtime.env['AI_COMPAT_API_KEY'] } : {}),
      });
      const reply = await generateText({
        model: provider.chatModel(runtime.env['AI_COMPAT_MODEL'] ?? 'local'),
        prompt: 'Reply with a short greeting.',
        maxOutputTokens: 64,
      });
      assert.ok(reply.text.length > 0);
    },
  );
});
