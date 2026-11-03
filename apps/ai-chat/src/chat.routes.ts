import { streamText, wrapLanguageModel, isStepCount, tool } from 'ai';
import { createFallback } from 'ai-fallback';
import { z } from 'zod';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, IRuntimeServices } from '@setu-ts/common';
import { QuotaExceededError, respondQuotaExceeded } from '@setu-ts/auth-plugin';
import type { IQuota } from '@setu-ts/auth-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import type { IOutbox } from '@setu-ts/messaging-plugin';
import { budgetMiddleware } from './budget-middleware.ts';
import type { BudgetPrices } from './budget-middleware.ts';
import { writeUsage } from './usage.ts';

/** Models are the plain LanguageModelV4 type returned by the SDK wrapper. */
export type PricedModel = { model: ReturnType<typeof wrapLanguageModel>; prices: BudgetPrices };
const identitySchema = z.object({ tenantId: z.string(), principalId: z.string().optional() });

/** A service checks trusted identity before returning tenant data. @returns The authorized tenant */
export function readTenant(identity: z.infer<typeof identitySchema>): string {
  if (!identity.tenantId) throw new Error('Tenant authorization failed');
  return identity.tenantId;
}

/** Identity travels in the SDK side channel, never in model-settable tool input. */
export const tenantTool = tool({
  description: 'Read the current authorized tenant',
  inputSchema: z.object({}),
  contextSchema: identitySchema,
  execute: (_input, { context }) => readTenant(context),
});

/** Registers a UI-message streaming route over individually budgeted fallback models. @returns Nothing */
export function registerChatRoutes(
  router: IRouterApi,
  models: readonly PricedModel[],
  quota: () => IQuota,
): void {
  router.post('/chat', {
    handler: async (ctx) => {
      const { prompt } = z
        .object({ prompt: z.string().min(1).max(10_000) })
        .parse(await ctx.request.json());
      const tenantId = ctx.request.tenant?.id;
      if (!tenantId) throw new TypeError('A server-resolved tenant is required');
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const outbox = ctx.services.get<IOutbox>(CAPABILITIES.OUTBOX);
      const wrapped = models.map(({ model, prices }) =>
        wrapLanguageModel({
          model,
          middleware: budgetMiddleware(ctx, quota(), runtime, prices, (record) =>
            writeUsage(db, outbox, record),
          ),
        }),
      );
      try {
        // streamText starts lazily. Wait for the first budgeted provider result
        // before committing HTTP headers, so an initial quota refusal can be 429.
        const ready = Promise.withResolvers<{ ok: true } | { ok: false; error: unknown }>();
        const model = wrapLanguageModel({
          model: createFallback({ models: wrapped }),
          middleware: {
            specificationVersion: 'v4',
            async wrapStream({ doStream }) {
              try {
                const response = await doStream();
                ready.resolve({ ok: true });
                return response;
              } catch (error) {
                ready.resolve({ ok: false, error });
                throw error;
              }
            },
          },
        });
        const result = streamText({
          model,
          prompt,
          maxOutputTokens: 128,
          stopWhen: isStepCount(3),
          abortSignal: ctx.signal,
          tools: { tenant: tenantTool },
          toolsContext: {
            tenant: {
              tenantId,
              ...(ctx.request.user?.id === undefined ? {} : { principalId: ctx.request.user.id }),
            },
          },
          telemetry: { recordInputs: false, recordOutputs: false },
          onError: ({ error }) => ready.resolve({ ok: false, error }),
        });
        const outcome = await ready.promise;
        if (!outcome.ok) throw outcome.error;
        const response = result.toUIMessageStreamResponse();
        ctx.response.status(response.status);
        response.headers.forEach((value, name) => ctx.response.header(name, value));
        return ctx.response.stream(response.body!);
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          respondQuotaExceeded(ctx, error);
          const snapshot = ctx.response.snapshot();
          if (snapshot.streaming) throw error;
          return ctx.response.send(
            typeof snapshot.body === 'string'
              ? new TextEncoder().encode(snapshot.body)
              : (snapshot.body ?? undefined),
          );
        }
        // QuotaStoreUnavailableError carries a 503 hint that errorHandler answers.
        throw error;
      }
    },
  });
}
