import {
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  tool,
  toUIMessageStream,
} from 'ai';
import type { TextStreamPart, ToolSet } from 'ai';
import { z } from 'zod';
import type { HandlerResult, IRequestContext, IRouterApi, IServiceRegistry } from '@setu-ts/common';
import { QuotaExceededError, respondQuotaExceeded } from '@setu-ts/auth-plugin';
import { validateBody } from '@setu-ts/validation-plugin';
import { CHAT_MODELS } from '../../plugins/chat-models.plugin.ts';
import type { IChatModelsService } from '../../plugins/chat-models.plugin.ts';
import { budgetedModel } from './chat.budget.ts';
import { ChatBody, ChatModelInfo } from './chat.schemas.ts';
import type { ChatUsageMetadata } from './chat.schemas.ts';
import { chatQuota } from './chat.service.ts';

const chatBody = validateBody(ChatBody);

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

const tools = { tenant: tenantTool };

/** The output-token limit every turn is called with. */
export const MAX_OUTPUT_TOKENS = 1024;

/**
 * The usage of a finished turn, as message metadata on the stream's `finish`
 * event, so a client can count tokens and context. Other parts carry none.
 *
 * @param options - The stream part the SDK is converting
 * @returns The metadata for a `finish` part, otherwise `undefined`
 */
export function usageMetadata({
  part,
}: {
  part: TextStreamPart<ToolSet>;
}): ChatUsageMetadata | undefined {
  if (part.type !== 'finish') return undefined;
  const { inputTokens, outputTokens, outputTokenDetails } = part.totalUsage;
  return {
    usage: {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(outputTokenDetails.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: outputTokenDetails.reasoningTokens }),
    },
  };
}

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

/** Registers the chat feature routes: UI-message streaming over individually budgeted fallback models. */
export function registerChatRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  const quota = chatQuota();
  router.get('/chat/model', {
    schema: { response: { 200: ChatModelInfo } },
    handler: (ctx) => {
      const { contextTokens } = ctx.services.get<IChatModelsService>(CHAT_MODELS);
      return ctx.response.json({
        contextTokens: contextTokens ?? null,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      } satisfies ChatModelInfo);
    },
  });
  router.post('/chat', {
    middleware: [quotaRefusal, chatBody],
    handler: async (ctx) => {
      const { prompt, history = [] } = chatBody.value(ctx);
      const tenantId = ctx.request.tenant?.id;
      if (!tenantId) throw new TypeError('A server-resolved tenant is required');
      const { models } = ctx.services.get<IChatModelsService>(CHAT_MODELS);
      const { model, ready } = budgetedModel(ctx, models, quota(ctx));
      const result = streamText({
        model,
        // The client resends the conversation; the server keeps none.
        ...(history.length === 0
          ? { prompt }
          : { messages: [...history, { role: 'user' as const, content: prompt }] }),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // The SDK would retry after the error response has gone out; ai-fallback fails over instead.
        maxRetries: 0,
        stopWhen: isStepCount(3),
        abortSignal: ctx.signal,
        tools,
        toolsContext: {
          tenant: {
            tenantId,
            ...(ctx.request.user?.id === undefined ? {} : { principalId: ctx.request.user.id }),
          },
        },
        telemetry: { recordInputs: false, recordOutputs: false },
        // Errors before the stream reach the client through the awaits below.
        onError: () => {},
      });
      // ready settles once the first model call starts. A failure before any
      // model call (prompt or URL-support checks) only rejects result.response,
      // and nothing else starts the stream until headers are sent.
      const failed = Promise.resolve(result.response).then(() => undefined);
      // Later failures reach the client inside the UI stream, not here.
      failed.catch(() => {});
      await Promise.race([ready, failed]);
      return sendUIResponse(
        ctx,
        createUIMessageStreamResponse({
          stream: toUIMessageStream({
            stream: result.stream,
            tools,
            messageMetadata: usageMetadata,
          }),
        }),
      );
    },
  });
}

function sendUIResponse(ctx: IRequestContext, response: Response): HandlerResult {
  ctx.response.status(response.status);
  // The server owns connection management; the SDK's `connection: keep-alive` would
  // override a client's `Connection: close` and hold its socket open.
  response.headers.forEach((value, name) => {
    if (name !== 'connection') ctx.response.header(name, value);
  });
  return ctx.response.stream(response.body!);
}
