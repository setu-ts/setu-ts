import { APICallError, wrapLanguageModel } from 'ai';
import type { LanguageModelMiddleware } from 'ai';
import { createFallback, defaultShouldRetryThisError } from 'ai-fallback';
import type { IRequestContext, IRuntimeServices, ILogger } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { IQuota } from '@setu-ts/auth-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import type { IOutbox } from '@setu-ts/messaging-plugin';
import { writeUsage } from './chat.usage.ts';
import type { UsageRecord } from './chat.usage.ts';

// ai's public alias retains the V4 middleware shape; specifying v4 below keeps
// provider types selected by the pinned ai release, with no independent provider pin.
type CallParams = Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]['params'];
type Usage = Awaited<
  ReturnType<Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]['doGenerate']>
>['usage'];

/** Example prices in integer billing units per token, plus conservative input allowances. */
export type BudgetPrices = {
  inputPrice: number;
  outputPrice: number;
  perMessage: number;
  perFile: number;
};

/** A V4 model with its own billing prices and input allowances. */
export type PricedModel = { model: ReturnType<typeof wrapLanguageModel>; prices: BudgetPrices };

/**
 * Wires per-provider budgets, usage delivery and fallback for one request.
 * @param ctx - Live request context with trusted identity and cancellation
 * @param models - Providers with their individual prices
 * @param quota - This application's shared quota
 * @returns The SDK model and readiness promise; readiness rejects on an initial provider or quota failure
 */
export function budgetedModel(
  ctx: IRequestContext,
  models: readonly PricedModel[],
  quota: IQuota,
): {
  model: ReturnType<typeof wrapLanguageModel>;
  ready: Promise<void>;
} {
  const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
  const outbox = ctx.services.get<IOutbox>(CAPABILITIES.OUTBOX);
  const wrapped = models.map(({ model, prices }) =>
    wrapLanguageModel({
      model,
      middleware: budgetMiddleware(ctx, quota, runtime, prices, (record) =>
        writeUsage(db, outbox, record),
      ),
    }),
  );
  const ready = Promise.withResolvers<void>();
  const model = wrapLanguageModel({
    model: createFallback({
      models: wrapped,
      shouldRetryThisError: (error) =>
        (APICallError.isInstance(error) && error.isRetryable) || defaultShouldRetryThisError(error),
    }),
    middleware: {
      specificationVersion: 'v4',
      async wrapStream({ doStream }) {
        try {
          const response = await doStream();
          ready.resolve();
          return response;
        } catch (error) {
          ready.reject(error);
          throw error;
        }
      },
    },
  });
  return { model, ready: ready.promise };
}

/**
 * Reserves each provider call separately and records its settlement through the outbox.
 * Identity is server-set on ctx.request; neither the body nor model arguments select the key.
 * @returns AI SDK V4 middleware for one request and one model's prices
 */
export function budgetMiddleware(
  ctx: IRequestContext,
  quota: IQuota,
  runtime: IRuntimeServices,
  prices: BudgetPrices,
  write: (record: UsageRecord) => Promise<unknown>,
): LanguageModelMiddleware {
  const tenantId = ctx.request.tenant?.id;
  if (!tenantId) throw new TypeError('A server-resolved tenant is required');
  const encoder = new TextEncoder();

  function estimate(params: CallParams): number {
    if (
      !Number.isSafeInteger(params.maxOutputTokens) ||
      params.maxOutputTokens === undefined ||
      params.maxOutputTokens < 0
    )
      throw new TypeError('maxOutputTokens is required');
    let media = 0;
    const prompt = params.prompt.map((message) => ({
      ...message,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => {
              if (part.type === 'file') {
                media++;
                return { type: 'file' };
              }
              return part;
            }),
    }));
    const bytes = encoder.encode(JSON.stringify({ prompt, tools: params.tools ?? [] })).byteLength;
    const inputBound = bytes + params.prompt.length * prices.perMessage + media * prices.perFile;
    return inputBound * prices.inputPrice + params.maxOutputTokens * prices.outputPrice;
  }

  // Only the two totals are priced. Providers omit detail counts routinely
  // (openai-compatible never reports cacheWrite), so those stay optional.
  function countsKnown(usage: Usage | undefined): boolean {
    const input = usage?.inputTokens.total;
    const output = usage?.outputTokens.total;
    return (
      input !== undefined &&
      Number.isSafeInteger(input) &&
      input >= 0 &&
      output !== undefined &&
      Number.isSafeInteger(output) &&
      output >= 0
    );
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
      async release() {
        if (!completed) {
          completed = true;
          await quota.release(receipt);
        }
      },
      async finish(usage?: Usage) {
        if (completed) return;
        completed = true;
        const priced = countsKnown(usage)
          ? usage!.inputTokens.total! * prices.inputPrice +
            usage!.outputTokens.total! * prices.outputPrice
          : undefined;
        // Safe counts can still price past MAX_SAFE_INTEGER; those settle at the reservation.
        const known = !ctx.signal.aborted && Number.isSafeInteger(priced);
        const settledAmount = known ? priced! : receipt.amount;
        await quota.settle(receipt, settledAmount);
        await write({
          id,
          occurredAt,
          tenantId: tenantId!,
          ...(ctx.request.user?.id === undefined ? {} : { principalId: ctx.request.user.id }),
          provider: model.provider,
          model: model.modelId,
          usageKnown: known,
          settledAmount,
          ...(known
            ? {
                inputTokens: usage!.inputTokens.total!,
                ...optional('cacheReadTokens', usage!.inputTokens.cacheRead),
                ...optional('cacheWriteTokens', usage!.inputTokens.cacheWrite),
                outputTokens: usage!.outputTokens.total!,
                ...optional('reasoningTokens', usage!.outputTokens.reasoning),
              }
            : {}),
        });
      },
    };
  }

  return {
    specificationVersion: 'v4',
    async wrapGenerate({ doGenerate, params, model }) {
      const call = await begin(params, model);
      let result: Awaited<ReturnType<typeof doGenerate>>;
      try {
        result = await doGenerate();
      } catch (error) {
        await call.release();
        throw error;
      }
      await call.finish(result.usage);
      return result;
    },
    async wrapStream({ doStream, params, model }) {
      const call = await begin(params, model);
      let result: Awaited<ReturnType<typeof doStream>>;
      let first: ReadableStreamReadResult<
        Awaited<ReturnType<typeof doStream>>['stream'] extends ReadableStream<infer T> ? T : never
      >;
      let reader: ReturnType<Awaited<ReturnType<typeof doStream>>['stream']['getReader']>;
      try {
        result = await doStream();
        reader = result.stream.getReader();
        first = await reader.read();
        if (!first.done && first.value.type === 'error') throw first.value.error;
      } catch (error) {
        await call.release();
        throw error;
      }
      let usage: Usage | undefined;
      let pending = true;
      const abort = () => {
        void reader.cancel().catch((error: unknown) => {
          if (ctx.services.has(CAPABILITIES.LOGGER))
            ctx.services
              .get<ILogger>(CAPABILITIES.LOGGER)
              .warn('Provider stream cancellation failed', { error: String(error) });
        });
      };
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
              if (part.value.type === 'error') {
                usage = undefined;
                await call.finish();
              }
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
