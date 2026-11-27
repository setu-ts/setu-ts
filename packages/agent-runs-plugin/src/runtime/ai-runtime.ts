import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { LanguageModel, ModelMessage, ToolSet, UIMessageChunk } from 'ai';

/** Minimal real-SDK seam; fake implementations must honour these signatures. @internal */
export interface AiRuntime {
  readonly headers: Readonly<Record<string, string>>;
  model(options: {
    model: LanguageModel;
    messages: ModelMessage[];
    tools: ToolSet;
    maxOutputTokens: number;
    abortSignal: AbortSignal;
    system?: string;
  }): {
    readonly chunks: ReadableStream<UIMessageChunk>;
    /** Original model error captured by the UI stream's onError callback. */
    readonly failure: () => unknown;
    readonly result: () => Promise<{
      messages: ModelMessage[];
      finishReason: string;
      usage: unknown;
    }>;
  };
}
/** Real guarded loader; called once at registration. @internal */
export async function loadAi(): Promise<AiRuntime> {
  try {
    const ai = await import('ai');
    return {
      headers: ai.UI_MESSAGE_STREAM_HEADERS,
      model(options) {
        let failure: unknown;
        // The SDK's default onError logs provider text. The UI error below
        // becomes a value-free failed run instead.
        const result = ai.streamText({ ...options, onError: () => {} });
        return {
          chunks: ai.toUIMessageStream({
            stream: result.stream,
            tools: options.tools,
            sendStart: false,
            sendFinish: false,
            onError: (error) => {
              failure = error;
              return 'Agent model call failed.';
            },
          }),
          failure: () => failure,
          async result() {
            return {
              messages: await result.responseMessages,
              finishReason: await result.finishReason,
              usage: await result.usage,
            };
          },
        };
      },
    };
  } catch (cause) {
    throw new OptionalDependencyUnavailableError('ai', {
      cause,
      requiredBy: '@setu-ts/agent-runs-plugin',
    });
  }
}
