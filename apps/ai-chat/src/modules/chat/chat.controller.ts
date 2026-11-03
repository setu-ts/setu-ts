import { streamText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import type { HandlerResult, IRequestContext, IRouterApi } from '@setu-ts/common';
import { QuotaExceededError, respondQuotaExceeded } from '@setu-ts/auth-plugin';
import type { IQuota } from '@setu-ts/auth-plugin';
import { budgetedModel } from './chat.budget.ts';
import type { PricedModel } from './chat.budget.ts';

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

/** Answers initial quota refusals before a UI stream has been sent. */
async function quotaRefusal(ctx: IRequestContext, next: () => Promise<void>): Promise<void> {
  try {
    await next();
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      respondQuotaExceeded(ctx, error);
      return;
    }
    throw error;
  }
}

/** Registers a UI-message streaming route over individually budgeted fallback models. @returns Nothing */
export function registerChatRoutes(
  router: IRouterApi,
  models: readonly PricedModel[],
  quota: (ctx: IRequestContext) => IQuota,
): void {
  router.post('/chat', {
    middleware: [quotaRefusal],
    handler: async (ctx) => {
      const { prompt } = z
        .object({ prompt: z.string().min(1).max(10_000) })
        .parse(await ctx.request.json());
      const tenantId = ctx.request.tenant?.id;
      if (!tenantId) throw new TypeError('A server-resolved tenant is required');
      const { model, ready } = budgetedModel(ctx, models, quota(ctx));
      const result = streamText({
        model,
        prompt,
        maxOutputTokens: 1024,
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
        // Initial errors are reported through ready before headers are sent.
        onError: () => {},
      });
      await ready;
      return sendUIResponse(ctx, result.toUIMessageStreamResponse());
    },
  });
}

function sendUIResponse(ctx: IRequestContext, response: Response): HandlerResult {
  ctx.response.status(response.status);
  response.headers.forEach((value, name) => ctx.response.header(name, value));
  return ctx.response.stream(response.body!);
}
