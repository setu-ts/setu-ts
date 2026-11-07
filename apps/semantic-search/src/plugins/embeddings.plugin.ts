import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { EmbeddingModel } from 'ai';
import { createCapabilityToken } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';

/** Capability token this plugin provides. */
export const EMBEDDINGS = createCapabilityToken('embeddings');

/** The service registered under {@linkcode EMBEDDINGS}. */
export interface IEmbeddingsService {
  /** The model `embed`/`embedMany` call. */
  readonly model: EmbeddingModel;
}

/**
 * The vector length the configured model returns, from `EMBED_DIMENSIONS`
 * (default 1024, Qwen3-Embedding-0.6B's). The `documents` collection is
 * declared with it, so a model that returns another length is refused at the
 * store rather than stored.
 *
 * @param env - The process or runtime environment
 * @returns The declared dimensions
 */
export function embeddingDimensions(env: Readonly<Record<string, string | undefined>>): number {
  return Number(env['EMBED_DIMENSIONS'] ?? '1024');
}

/**
 * Registers the embeddings capability.
 *
 * Registered for you through the `GENERATED_PLUGINS` barrel in
 * `src/plugins/index.ts`, which `setu.config.ts` spreads into
 * `createApplication({ plugins })` — so this module needs no further wiring. Delete
 * this file to stop registering it; the barrel is regenerated from the directory.
 *
 * Any OpenAI-compatible `/v1/embeddings` server works (llama.cpp, vLLM, Ollama,
 * OpenAI): `EMBED_BASE_URL`, `EMBED_MODEL` and `EMBED_API_KEY` come from the
 * server environment, never from a request.
 *
 * @returns The plugin to pass to `createApplication({ plugins: [...] })`
 */
export function EmbeddingsPlugin(): IPlugin {
  return {
    name: 'embeddings',
    version: '0.1.0',
    provides: [EMBEDDINGS],
    register(ctx: IPluginContext): void {
      const env = ctx.runtime.env;
      const provider = createOpenAICompatible({
        name: 'embeddings',
        baseURL: env['EMBED_BASE_URL'] ?? 'http://localhost:8081/v1',
        ...(env['EMBED_API_KEY'] ? { apiKey: env['EMBED_API_KEY'] } : {}),
      });
      const service: IEmbeddingsService = {
        model: provider.embeddingModel(env['EMBED_MODEL'] ?? 'qwen3-embedding-0.6b'),
      };
      ctx.services.register(EMBEDDINGS, service);
    },
  };
}
