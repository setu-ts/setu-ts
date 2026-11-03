# AI calls with Setu-TS

Use the Vercel AI SDK for providers, tool loops, structured output, UI streams and test models,
`ai-fallback` for provider fallback, and `@ai-sdk/otel` for GenAI spans. Setu supplies request
identity, cancellation, weighted quotas and transactional usage delivery. There is no Setu AI plugin
or AI capability token. No published Setu package depends on the AI SDK.

The [runnable example](../apps/ai-chat) proves these recipes on **Node 24**. The AI SDK integration
has not been verified on Deno, Bun or Workers. The quota itself uses runtime services and web APIs.

## Install

```bash
npm install ai@7 @ai-sdk/openai-compatible@3 ai-fallback@3 @ai-sdk/otel@1
```

Pin one exact `ai` release in your application and let it select its provider packages. The example
uses `ai` 7.0.159 to match `@ai-sdk/otel` 1.0.159's own SDK dependency. Independently pinning
`@ai-sdk/provider` or mixing SDK patch releases can create incompatible schema types. The provider
model is the plain `LanguageModelV4` type; it is not a generic. The examples below use the SDK
wrapper's return type to consume that type without a separate provider dependency.

## Stream a UI response

```typescript
import { streamText, wrapLanguageModel } from 'ai';
import type { HandlerResult, IRequestContext } from '@setu-ts/common';

export function chat(ctx: IRequestContext, model: ReturnType<typeof wrapLanguageModel>): HandlerResult {
  const result = streamText({
    model, prompt: 'Explain reserve and settle.', maxOutputTokens: 128,
    abortSignal: ctx.signal,
    telemetry: { recordInputs: false, recordOutputs: false },
  });
  const response = result.toUIMessageStreamResponse();
  ctx.response.status(response.status);
  response.headers.forEach((value, name) => ctx.response.header(name, value));
  return ctx.response.stream(response.body!);
}
```

The SDK produces SSE `data:` lines, ending with `data: [DONE]`, and the header
`x-vercel-ai-ui-message-stream: v1`. Forward its headers and body through the response writer; the
wire format is already implemented by the SDK. The example smoke reads the result with
`parseJsonEventStream`, `uiMessageChunkSchema` and `readUIMessageStream` from `ai`.

`streamText` starts asynchronously. The example's [route](../apps/ai-chat/src/chat.routes.ts) waits
for the first budgeted provider result before committing HTTP headers, so an initial quota refusal
can answer 429. A failure after streaming has begun is a stream failure; the HTTP status has already
been sent.

## Bounded tools with trusted identity

```typescript
import { generateText, isStepCount, tool, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import type { IRequestContext } from '@setu-ts/common';

const identity = z.object({ tenantId: z.string(), principalId: z.string().optional() });
function authorizedTenant(value: z.infer<typeof identity>): string {
  if (!value.tenantId) throw new Error('Tenant authorization failed');
  return value.tenantId; // Apply the service's resource-specific authorization here.
}
const tenant = tool({
  description: 'Read the authorized tenant', inputSchema: z.object({}), contextSchema: identity,
  execute: (_input, { context }) => authorizedTenant(context),
});
export async function runTools(ctx: IRequestContext, model: ReturnType<typeof wrapLanguageModel>): Promise<string> {
  const tenantId = ctx.request.tenant?.id;
  if (!tenantId) throw new Error('Tenant required');
  const result = await generateText({
    model, prompt: 'Read my tenant.', tools: { tenant },
    toolsContext: { tenant: { tenantId, ...(ctx.request.user?.id === undefined ? {} : { principalId: ctx.request.user.id }) } },
    stopWhen: isStepCount(3), abortSignal: ctx.signal, maxOutputTokens: 128,
    telemetry: { recordInputs: false, recordOutputs: false },
  });
  return result.text;
}
```

`stopWhen` and `toolsContext` are call settings. Context is keyed by tool name and reaches the
tool's `context` argument. The SDK executes the tool loop and stops at the step cap. Identity comes
from `ctx.request.tenant?.id` and `ctx.request.user?.id`, populated by trusted server middleware.
Bind the tenancy resolver to the authenticated caller; an arbitrary tenant header is not proof of
membership. Neither tool input nor a request body's tenant field may select the quota key or tool
identity. Keep authorization in the service called by the tool. Use `ctx.signal`, which is always
live, for cancellation.

## Structured output

```typescript
import { generateText, NoObjectGeneratedError, Output, wrapLanguageModel } from 'ai';
import { z } from 'zod';

export async function answer(model: ReturnType<typeof wrapLanguageModel>): Promise<number | null> {
  try {
    const result = await generateText({ model, prompt: 'Return an answer.',
      output: Output.object({ schema: z.object({ answer: z.number() }) }),
      telemetry: { recordInputs: false, recordOutputs: false },
    });
    return result.output.answer;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) return null;
    throw error;
  }
}
```

## Provider fallback

```typescript
import { generateText, wrapLanguageModel } from 'ai';
import { createFallback } from 'ai-fallback';

export async function fallback(primary: ReturnType<typeof wrapLanguageModel>, secondary: ReturnType<typeof wrapLanguageModel>): Promise<string> {
  const result = await generateText({ model: createFallback({ models: [primary, secondary] }),
    prompt: 'Hello', maxOutputTokens: 128,
    telemetry: { recordInputs: false, recordOutputs: false },
  });
  return result.text;
}
```

Wrap **each** model with its own budget middleware and prices before passing it to `createFallback`.
A first model that fails before its first stream part releases its reservation, then the second
reserves at its own price. The smoke proves fallback after a 503 and reads the remaining budget to
prove the first reservation was released. The library owns its retry classification; review that
policy for your providers. Configure provider URLs and credentials on the server. Model output must
never select an egress destination or carry an API key.

## GenAI telemetry without content capture

```typescript
import { registerTelemetry } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';
import { trace } from '@opentelemetry/api';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';

const app = createApplication({ plugins: [RuntimePlugin(), TelemetryPlugin({
  serviceName: 'ai-chat', exporter: 'otlp', endpoint: 'http://localhost:4318/v1/traces',
  registerGlobal: true,
})] });
await app.start();
registerTelemetry(new OpenTelemetry({ tracer: trace.getTracer('gen_ai') }));
```

Install telemetry-plugin's documented optional OTel peers when using its real exporter.
`registerGlobal` defaults to false. When enabled, libraries tracing through the OTel API use Setu's
provider, processors, sampler and diagnostics. Pass that API's tracer explicitly to `OpenTelemetry`
to avoid retaining an early proxy tracer from a second installed API copy. Use one global provider
per process: a refused second registration warns once and continues with a private provider.
Shutdown does not unregister it.

Every call in the recipes sets `telemetry: { recordInputs: false, recordOutputs: false }`.
**Enabling capture records prompt and completion content unredacted.** This milestone adds no
redacting span processor. Audit exporter access, retention and network egress before enabling it.
The smoke receives real OTLP/HTTP exports, checks request trace parenting and absence of prompt
text, then turns capture on as a positive control. These are the SDK's `gen_ai.*` spans, not a
second Setu GenAI instrumentation layer.

## Testing without a provider

```typescript
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const model = new MockLanguageModelV4({ doGenerate: () => Promise.resolve({
  content: [{ type: 'text', text: 'scripted' }],
  finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 } },
}) });
await generateText({ model, prompt: 'Hello', telemetry: { recordInputs: false, recordOutputs: false } });
```

Usage counts are nested (`inputTokens.total`, `outputTokens.total` and their details) and any of
them may be undefined; there is no combined input-plus-output total. `finishReason` is an object and
a provider tool call's `input` is a JSON string. The example uses the SDK mock for tool steps,
stream chunks, invalid structured output and fallback; Setu adds no test model.

## Weighted quotas

```typescript
import { createQuota, MemoryQuotaStore, RedisQuotaStore, respondQuotaExceeded, QuotaExceededError } from '@setu-ts/auth-plugin';
import type { IQuota, IQuotaRedisClient } from '@setu-ts/auth-plugin';
import type { IRuntimeServices, MiddlewareFunction } from '@setu-ts/common';

export function memoryQuota(runtime: IRuntimeServices): IQuota {
  return createQuota({ name: 'ai-spend', store: new MemoryQuotaStore(runtime), runtime, limit: 1_000_000, window: 'utc-month' });
}
export function redisQuota(client: IQuotaRedisClient, runtime: IRuntimeServices): IQuota {
  return createQuota({ name: 'ai-spend', store: new RedisQuotaStore({ client, namespace: 'my-app' }), runtime, limit: 1_000_000, window: 'utc-month' });
}
export function quotaRefusal(): MiddlewareFunction {
  return async (ctx, next) => {
    try { await next(); }
    catch (error) { if (error instanceof QuotaExceededError) respondQuotaExceeded(ctx, error); else throw error; }
  };
}
```

Amounts and limits are non-negative safe integers in caller-chosen units, such as micro-dollars.
Reserve before work; settle once with actual usage, or release with zero. Only the issuing quota
accepts its frozen receipt; replayed settlement does nothing. A per-key limit callback can return
undefined for unlimited usage, which is still recorded. Keys are non-empty and at most 512 UTF-8
bytes. Names match `[a-z0-9-]+`. Store failures refuse with `QuotaStoreUnavailableError`, which
`errorHandler` answers as a value-free 503.

Windows are positive integer milliseconds aligned to the epoch, `utc-day`, or `utc-month`.
Settlement always charges the reserved window; windows expire at their end plus one day. Memory
storage is single-process and sweeps expired entries on access. Redis uses atomic constant Lua
scripts, passing all caller values through KEYS/ARGV, with absolute expiry. Use Redis for a budget
shared across processes. `RedisQuotaStore.close()` quits its injected client; use a dedicated
client.

`respondQuotaExceeded` adds `Retry-After`. An uncaught `QuotaExceededError` carries the same status
hint through `errorHandler`, but the hint contract cannot carry a header. Under RFC 9457 both carry
the IANA quota-exceeded type, the policy name and `retry-after` seconds; they expose no tenant usage
or limit. The existing request-rate limiter keeps its original bytes and headers.

## Budget middleware

The following is the example's provider middleware. `LanguageModelMiddleware` is `ai`'s public alias
for the provider's V4 middleware shape with a relaxed version field; setting
`specificationVersion: 'v4'` supplies the `LanguageModelV4Middleware` contract. This avoids an
independent provider dependency.

The reservation is `inputBound × inputPrice + maxOutputTokens × outputPrice`. `inputBound` counts
UTF-8 bytes of serialized text and tool definitions, adds a chat-template allowance per message, and
a configured allowance per file/image part. A byte-level tokenizer emits at most one token per byte;
the per-message allowance must also bound your model's chat template. A URL's length does not bound
the content it points at. The cap is hard for text under those assumptions and only as tight as the
configured media allowance. The byte estimate often over-reserves English text by roughly 3–4 times.
Prices and allowances must be conservative non-negative integer billing units; use your model's
actual tariff and media limits. `maxOutputTokens` is required.

The middleware refunds the difference when the input and output totals are known, charges the full
reservation when either total is missing or the request aborts, and releases on provider failure
before its first stream part. Cached input and reasoning tokens are included in their respective
input/output totals, so this recipe uses one price for all input tokens and one for all output
tokens.

```typescript
import type { LanguageModelMiddleware } from 'ai';
import type { IRequestContext, IRuntimeServices, ILogger } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { IQuota } from '@setu-ts/auth-plugin';
import { z } from 'zod';
/** Billing input, with no prompt or completion content. */
export const usageSchema = z.object({
  id: z.string(), occurredAt: z.string(), tenantId: z.string(), principalId: z.string().optional(),
  provider: z.string(), model: z.string(), usageKnown: z.boolean(),
  inputTokens: z.number().optional(), cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional(),
  outputTokens: z.number().optional(), reasoningTokens: z.number().optional(), settledAmount: z.number(),
});
/** One provider call, identified before the provider is invoked. */
export type UsageRecord = z.infer<typeof usageSchema>;


// ai's public alias retains the V4 middleware shape; specifying v4 below keeps
// provider types selected by the pinned ai release, with no independent provider pin.
type CallParams = Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]['params'];
type Usage = Awaited<ReturnType<Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]['doGenerate']>>['usage'];

/** Example prices in integer billing units per token, plus conservative input allowances. */
export type BudgetPrices = { inputPrice: number; outputPrice: number; perMessage: number; perFile: number };

/**
 * Reserves each provider call separately and records its settlement through the outbox.
 * Identity is server-set on ctx.request; neither the body nor model arguments select the key.
 * @returns AI SDK V4 middleware for one request and one model's prices
 */
export function budgetMiddleware(ctx: IRequestContext, quota: IQuota, runtime: IRuntimeServices, prices: BudgetPrices, write: (record: UsageRecord) => Promise<unknown>): LanguageModelMiddleware {
  const tenantId = ctx.request.tenant?.id;
  if (!tenantId) throw new TypeError('A server-resolved tenant is required');
  const encoder = new TextEncoder();

  function estimate(params: CallParams): number {
    if (!Number.isSafeInteger(params.maxOutputTokens) || params.maxOutputTokens === undefined || params.maxOutputTokens < 0) throw new TypeError('maxOutputTokens is required');
    let media = 0;
    const prompt = params.prompt.map((message) => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.map((part) => {
      if (part.type === 'file') { media++; return { type: 'file' }; }
      return part;
    }) }));
    const bytes = encoder.encode(JSON.stringify({ prompt, tools: params.tools ?? [] })).byteLength;
    const inputBound = bytes + params.prompt.length * prices.perMessage + media * prices.perFile;
    return inputBound * prices.inputPrice + params.maxOutputTokens * prices.outputPrice;
  }

  // Only the two totals are priced; providers omit detail counts (openai-compatible never reports cacheWrite).
  function countsKnown(usage: Usage | undefined): boolean {
    return usage?.inputTokens.total !== undefined && usage.outputTokens.total !== undefined;
  }
  function optional<K extends string>(name: K, value: number | undefined) {
    return value === undefined ? {} : ({ [name]: value } as Record<K, number>);
  }

  async function begin(params: CallParams, model: { provider: string; modelId: string }) {
    const id = runtime.uuid();
    const occurredAt = new Date(runtime.now()).toISOString();
    const receipt = await quota.reserve(tenantId!, estimate(params));
    let completed = false;
    return {
      async release() { if (!completed) { completed = true; await quota.release(receipt); } },
      async finish(usage?: Usage) {
        if (completed) return;
        completed = true;
        const known = !ctx.signal.aborted && countsKnown(usage);
        const settledAmount = known ? usage!.inputTokens.total! * prices.inputPrice + usage!.outputTokens.total! * prices.outputPrice : receipt.amount;
        await quota.settle(receipt, settledAmount);
        await write({ id, occurredAt, tenantId: tenantId!, ...(ctx.request.user?.id === undefined ? {} : { principalId: ctx.request.user.id }), provider: model.provider, model: model.modelId, usageKnown: known, settledAmount,
          ...(known ? { inputTokens: usage!.inputTokens.total!, outputTokens: usage!.outputTokens.total!, ...optional('cacheReadTokens', usage!.inputTokens.cacheRead), ...optional('cacheWriteTokens', usage!.inputTokens.cacheWrite), ...optional('reasoningTokens', usage!.outputTokens.reasoning) } : {}) });
      },
    };
  }

  return {
    specificationVersion: 'v4',
    async wrapGenerate({ doGenerate, params, model }) {
      const call = await begin(params, model);
      let result: Awaited<ReturnType<typeof doGenerate>>;
      try { result = await doGenerate(); } catch (error) { await call.release(); throw error; }
      await call.finish(result.usage);
      return result;
    },
    async wrapStream({ doStream, params, model }) {
      const call = await begin(params, model);
      let result: Awaited<ReturnType<typeof doStream>>;
      let first: ReadableStreamReadResult<Awaited<ReturnType<typeof doStream>>['stream'] extends ReadableStream<infer T> ? T : never>;
      let reader: ReturnType<Awaited<ReturnType<typeof doStream>>['stream']['getReader']>;
      try {
        result = await doStream();
        reader = result.stream.getReader();
        first = await reader.read();
        if (!first.done && first.value.type === 'error') throw first.value.error;
      } catch (error) { await call.release(); throw error; }
      let usage: Usage | undefined;
      let pending = true;
      const abort = () => { void reader.cancel().catch((error: unknown) => { if (ctx.services.has(CAPABILITIES.LOGGER)) ctx.services.get<ILogger>(CAPABILITIES.LOGGER).warn('Provider stream cancellation failed', { error: String(error) }); }); };
      ctx.signal.addEventListener('abort', abort, { once: true });
      if (ctx.signal.aborted) abort();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const part = pending ? first : await reader.read();
            pending = false;
            if (part.done || ctx.signal.aborted) {
              ctx.signal.removeEventListener('abort', abort);
              await call.finish(usage);
              controller.close();
            } else {
              if (part.value.type === 'finish') usage = part.value.usage;
              if (part.value.type === 'error') { usage = undefined; await call.finish(); }
              controller.enqueue(part.value);
            }
          } catch (error) {
            ctx.signal.removeEventListener('abort', abort);
            await call.finish();
            controller.error(error);
          }
        },
        async cancel() {
          ctx.signal.removeEventListener('abort', abort);
          await reader.cancel();
          await call.finish();
        },
      });
      return { ...result, stream };
    },
  };
}
```

The complete [budget middleware](../apps/ai-chat/src/budget-middleware.ts) and
[route wiring](../apps/ai-chat/src/chat.routes.ts) show how each fallback model gets its own prices.

## Usage delivery

Take `id = runtime.uuid()` before each provider call. Write the record in the same local transaction
as the outbox entry; use that producer id as `deduplicationId`. The billing subscription uses the
inbox transaction for its write, so a redelivered envelope is read back once.

```typescript
import { z } from 'zod';
import { defineIntegrationEvent, onIntegrationEvent } from '@setu-ts/messaging-plugin';
import type { IOutbox, SubscriptionEntry } from '@setu-ts/messaging-plugin';
import type { IDatabaseService, IUnitOfWork } from '@setu-ts/database-plugin';

/** Billing input, with no prompt or completion content. */
export const usageSchema = z.object({
  id: z.string(), occurredAt: z.string(), tenantId: z.string(), principalId: z.string().optional(),
  provider: z.string(), model: z.string(), usageKnown: z.boolean(),
  inputTokens: z.number().optional(), cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional(),
  outputTokens: z.number().optional(), reasoningTokens: z.number().optional(), settledAmount: z.number(),
});
/** One provider call, identified before the provider is invoked. */
export type UsageRecord = z.infer<typeof usageSchema>;
/** Versioned usage event; the producer id is also its deduplication id. */
export const usageRecorded = defineIntegrationEvent({ type: 'ai.usage-recorded', version: 1, topic: 'ai.usage-recorded.v1', parse: (value) => usageSchema.parse(value) });

/** Writes a record transactionally to the outbox. @returns The stored envelope id */
export function writeUsage(db: IDatabaseService, outbox: IOutbox, record: UsageRecord): Promise<string> {
  return db.transaction((uow) => outbox.write(uow, usageRecorded, record, { options: { deduplicationId: record.id } }));
}

/** The inbox and billing write share the consumer's transaction. @returns Subscription wiring */
export function billingSubscription(): SubscriptionEntry {
  return onIntegrationEvent(usageRecorded, async (record, _envelope, _metadata, uow: IUnitOfWork) => {
    await uow.getRepository<UsageRecord>('Usage').create(record);
  }, { inbox: { consumer: 'billing' } });
}
```

Register `DatabasePlugin`, `SchedulerPlugin` and `MessagingPlugin` with
`outbox: { store: createDatabaseOutboxStore() }`, `inbox: { store: createDatabaseInboxStore() }` and
`subscriptions: [billingSubscription()]`, as the [composition root](../apps/ai-chat/setu.config.ts)
does. Use the existing database-plugin store bridges and a durable database for production. The
example uses the memory database, in-memory broker and scheduled outbox relay.

**Durability starts at the outbox write.** A process dying after the provider responds and before
the local transaction commits loses that usage record, even though the quota may already be settled.
This recipe does not close that process-crash window or integrate a billing vendor.
