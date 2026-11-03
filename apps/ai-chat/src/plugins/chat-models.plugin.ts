import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { OpenTelemetry } from '@ai-sdk/otel';
import { trace } from '@opentelemetry/api';
import { registerTelemetry } from 'ai';
import { createCapabilityToken } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import type { PricedModel } from '../modules/chat/chat.budget.ts';

/** Capability token this plugin provides. */
export const CHAT_MODELS = createCapabilityToken('chat-models');

// The AI SDK keeps telemetry integrations in a process-global list that never shrinks, so
// registering once per application would duplicate every AI span per app ever started.
let sdkTelemetryRegistered = false;

/** The service registered under {@linkcode CHAT_MODELS}. */
export interface IChatModelsService {
  /** Fallback order: each model is budgeted at its own prices. */
  readonly models: readonly PricedModel[];
}

/**
 * Registers the chat-models capability.
 *
 * Registered for you through the `GENERATED_PLUGINS` barrel in
 * `src/plugins/index.ts`, which `setu.config.ts` spreads into
 * `createApplication({ plugins })` — so this module needs no further wiring. Delete
 * this file to stop registering it; the barrel is regenerated from the directory.
 *
 * The provider URL, model and key come from the server environment
 * (`AI_COMPAT_BASE_URL`, `AI_COMPAT_MODEL`, `AI_COMPAT_API_KEY`), never from a request.
 * `includeUsage` asks OpenAI-compatible servers for streamed token usage; without it
 * every streamed call settles at its reservation.
 *
 * @returns The plugin to pass to `createApplication({ plugins: [...] })`
 */
export function ChatModelsPlugin(): IPlugin {
  return {
    name: 'chat-models',
    version: '0.1.0',
    provides: [CHAT_MODELS],
    register(ctx: IPluginContext): void {
      const env = ctx.runtime.env;
      const provider = createOpenAICompatible({
        name: 'compatible',
        baseURL: env['AI_COMPAT_BASE_URL'] ?? 'http://localhost:8080/v1',
        includeUsage: true,
        ...(env['AI_COMPAT_API_KEY'] ? { apiKey: env['AI_COMPAT_API_KEY'] } : {}),
      });
      // AI SDK spans reach Setu's tracer when telemetry-plugin registers globally.
      if (!sdkTelemetryRegistered) {
        registerTelemetry(new OpenTelemetry({ tracer: trace.getTracer('gen_ai') }));
        sdkTelemetryRegistered = true;
      }
      const service: IChatModelsService = {
        models: [
          {
            model: provider.chatModel(env['AI_COMPAT_MODEL'] ?? 'local'),
            prices: { inputPrice: 1, outputPrice: 1, perMessage: 64, perFile: 8192 },
          },
        ],
      };
      ctx.services.register(CHAT_MODELS, service);
    },
  };
}
