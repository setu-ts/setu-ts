import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { createCapabilityToken } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';

/** Capability token this plugin provides. */
export const SUPPORT_MODEL = createCapabilityToken('support-model');

/** The service registered under {@linkcode SUPPORT_MODEL}. */
export interface ISupportModelService {
  /** The model every step of a support run calls, resolved again on each step. */
  readonly model: LanguageModel;
}

/**
 * Registers the support-model capability.
 *
 * Registered for you through the `GENERATED_PLUGINS` barrel in
 * `src/plugins/index.ts`, which `setu.config.ts` spreads into
 * `createApplication({ plugins })` — so this module needs no further wiring. Delete
 * this file to stop registering it; the barrel is regenerated from the directory.
 *
 * Any OpenAI-compatible chat server with tool calling works (llama.cpp, vLLM,
 * Ollama, OpenAI): `AI_COMPAT_BASE_URL`, `AI_COMPAT_MODEL` and
 * `AI_COMPAT_API_KEY` come from the server environment, never from a request.
 * Tests replace the capability with a scripted mock model.
 *
 * @returns The plugin to pass to `createApplication({ plugins: [...] })`
 */
export function SupportModelPlugin(): IPlugin {
  return {
    name: 'support-model',
    version: '0.1.0',
    provides: [SUPPORT_MODEL],
    register(ctx: IPluginContext): void {
      const env = ctx.runtime.env;
      const provider = createOpenAICompatible({
        name: 'support',
        baseURL: env['AI_COMPAT_BASE_URL'] ?? 'http://localhost:8080/v1',
        includeUsage: true,
        ...(env['AI_COMPAT_API_KEY'] ? { apiKey: env['AI_COMPAT_API_KEY'] } : {}),
      });
      const service: ISupportModelService = {
        model: provider.chatModel(env['AI_COMPAT_MODEL'] ?? 'local'),
      };
      ctx.services.register(SUPPORT_MODEL, service);
    },
  };
}
